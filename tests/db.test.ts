import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observable } from "rxjs";
import {
  listSessions$,
  loadSessionDoc$,
} from "../src/db/queries";
import { createChroniclerDb, openDatabase } from "../src/db/opencode-db";
import { loadEnv } from "../src/config/env";
import { parseSessionMessage, parseSessionMeta, toIso } from "../src/db/v2parse";
import type { SessionMessageRow } from "../src/db/rows";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "chronicler-db-"));
const FIXTURE_DB = join(FIXTURE_DIR, "fixture.db");

function collect<T>(obs: Observable<T>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const out: T[] = [];
    obs.subscribe({
      next: (value) => out.push(value),
      error: reject,
      complete: () => resolve(out),
    });
  });
}

function buildFixture(): void {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const db = new Database(FIXTURE_DB, { create: true });
  db.run(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT,
      slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT,
      time_created INTEGER, time_updated INTEGER, time_suspended INTEGER,
      resume_attempts INTEGER, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT, seq INTEGER NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT,
      UNIQUE(session_id, seq)
    );
  `);

  const insertSession = db.prepare(
    `INSERT INTO session_v2
       (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, time_created, time_updated)
     VALUES ($id, $project_id, NULL, $parent_id, NULL, $directory, NULL, $title, $version, $time_created, $time_updated)`,
  );
  const sessions: Array<Record<string, string | number | null>> = [
    { $id: "s1", $project_id: "p1", $parent_id: null, $directory: "/home/x/alpha", $title: "Alpha Session", $version: "1.18.18", $time_created: 1000, $time_updated: 3000 },
    { $id: "s2", $project_id: "p1", $parent_id: null, $directory: "/home/x/beta", $title: "Beta", $version: "1.18.18", $time_created: 2000, $time_updated: 5000 },
    { $id: "s3", $project_id: "p2", $parent_id: "s1", $directory: "/home/x/gamma", $title: null, $version: null, $time_created: 1200, $time_updated: 4000 },
    { $id: "s4", $project_id: null, $parent_id: null, $directory: null, $title: "hidden", $version: null, $time_created: null, $time_updated: 1500 },
  ];
  for (const s of sessions) insertSession.run(s);

  const insertMessage = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES ($id, $session_id, $type, $seq, $time_created, $time_updated, $data)`,
  );
  const messages: Array<Record<string, string | number | null>> = [
    { $id: "m-user", $session_id: "s1", $type: "user", $seq: 4, $time_created: 1000, $time_updated: 1000,
      $data: JSON.stringify({ text: "Hello alpha", time: { created: 1000 }, files: [{ filename: "a.txt", mime: "text/plain" }, { url: "https://x/y/z.png" }] }) },
    { $id: "m-assistant", $session_id: "s1", $type: "assistant", $seq: 10, $time_created: 1100, $time_updated: 1100,
      $data: JSON.stringify({
        content: [
          { type: "text", text: "working" },
          { type: "reasoning", text: "thinking" },
          { type: "tool", id: "call_1", name: "bash", state: { status: "completed", input: { cmd: "ls" }, content: [{ type: "text", text: "file1\n" }, { type: "text", text: "file2" }] } },
          { type: "tool", id: "call_2", name: "read", state: { status: "error", input: { path: "x" }, error: "boom" } },
          { type: "tool", id: "call_3", name: "grep", state: { status: "running", input: { q: "x" } } },
          { type: "weird", foo: 1 },
        ],
        finish: "stop", cost: 0.01, tokens: { input: 10, output: 5 }, time: { created: 1100 },
      }) },
    { $id: "m-synthetic", $session_id: "s1", $type: "synthetic", $seq: 20, $time_created: 1200, $time_updated: 1200, $data: JSON.stringify({ text: "synthetic note", time: { created: 1200 } }) },
    { $id: "m-idle", $session_id: "s1", $type: "idle", $seq: 30, $time_created: 1300, $time_updated: 1300, $data: JSON.stringify({ time: 1300, outcome: "idled" }) },
    { $id: "m-model", $session_id: "s1", $type: "model-switched", $seq: 40, $time_created: 1400, $time_updated: 1400, $data: JSON.stringify({ time: 1400, model: "gpt-x", previous: "gpt-w" }) },
    { $id: "m-agent", $session_id: "s1", $type: "agent-switched", $seq: 50, $time_created: 1500, $time_updated: 1500, $data: JSON.stringify({ time: 1500, agent: "build", previous: "plan" }) },
    { $id: "m-compact", $session_id: "s1", $type: "compaction", $seq: 60, $time_created: 1600, $time_updated: 1600, $data: JSON.stringify({ time: 1600, reason: "context full" }) },
    { $id: "m-malformed", $session_id: "s1", $type: "assistant", $seq: 65, $time_created: 1700, $time_updated: 1700, $data: "{not valid json" },
    { $id: "m-unknown-type", $session_id: "s1", $type: "totally-new", $seq: 70, $time_created: 1800, $time_updated: 1800, $data: JSON.stringify({ x: 1, time: { created: 1800 } }) },
    { $id: "m-empty", $session_id: "s1", $type: "user", $seq: 681, $time_created: 1900, $time_updated: 1900, $data: JSON.stringify({}) },
    { $id: "m-s2u", $session_id: "s2", $type: "user", $seq: 1, $time_created: 2000, $time_updated: 2000, $data: JSON.stringify({ text: "Beta prompt" }) },
    { $id: "m-s4u", $session_id: "s4", $type: "user", $seq: 1, $time_created: 1500, $time_updated: 1500, $data: JSON.stringify({ text: "hidden prompt" }) },
  ];
  for (const m of messages) insertMessage.run(m);
  db.close();
}

beforeAll(() => buildFixture());
afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe("fixture isolation", () => {
  test("fixture lives under the OS temp dir and never touches the real db", () => {
    expect(FIXTURE_DB.startsWith(tmpdir())).toBe(true);
    expect(FIXTURE_DB.includes(".local/share/opencode")).toBe(false);
  });
});

describe("readonly gate", () => {
  test("openDatabase throws a descriptive Error when the file is missing", () => {
    expect(() => openDatabase(join(FIXTURE_DIR, "nope.db"))).toThrow(/not found/);
  });

  test("INSERT through the readonly handle throws", () => {
    const db = openDatabase(FIXTURE_DB);
    try {
      expect(() =>
        db.run(
          "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('x','s1','user',9999,0,0,'{}')",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("parseSessionMeta / ISO conversion", () => {
  test("toIso converts epoch-ms and is null-safe", () => {
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIso(1000)).toBe(new Date(1000).toISOString());
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso(Number.NaN)).toBeNull();
  });

  test("meta maps every column v2 → contract", () => {
    const meta = parseSessionMeta({
      id: "s1", title: "Alpha Session", directory: "/home/x/alpha",
      project_id: "p1", parent_id: null, version: "1.18.18",
      time_created: 1000, time_updated: 3000,
    });
    expect(meta).toEqual({
      id: "s1", title: "Alpha Session", directory: "/home/x/alpha",
      createdAt: new Date(1000).toISOString(), updatedAt: new Date(3000).toISOString(),
      projectID: "p1", parentID: null, version: "1.18.18",
    });
  });

  test("meta null fields survive", () => {
    const meta = parseSessionMeta({
      id: "s3", title: null, directory: null, project_id: null, parent_id: "s1",
      version: null, time_created: null, time_updated: null,
    });
    expect(meta.createdAt).toBeNull();
    expect(meta.updatedAt).toBeNull();
    expect(meta.title).toBeNull();
    expect(meta.parentID).toBe("s1");
  });
});

describe("loadSessionDoc$", () => {
  test("orders messages by seq ONLY (sparse seq preserved)", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    expect(docs.length).toBe(1);
    const seqIds = ["m-user", "m-assistant", "m-synthetic", "m-idle", "m-model", "m-agent", "m-compact", "m-malformed", "m-unknown-type", "m-empty"];
    expect(docs[0]!.messages.map((m) => m.id)).toEqual(seqIds);
  });

  test("not-found yields an empty Observable (0 emissions)", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "does-not-exist"));
    db.close();
    expect(docs).toEqual([]);
  });

  test("assistant: tool-call/tool-result pairing with equal callID", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const parts = docs[0]!.messages.find((m) => m.id === "m-assistant")!.parts;
    const calls = parts.filter((p) => p.kind === "tool-call");
    const results = parts.filter((p) => p.kind === "tool-result");
    expect(calls.map((p) => (p.kind === "tool-call" ? p.callID : ""))).toEqual(["call_1", "call_2", "call_3"]);
    expect(results.map((p) => (p.kind === "tool-result" ? p.callID : ""))).toEqual(["call_1", "call_2"]);
    for (const call of calls) {
      const result = results.find((p) => p.kind === "tool-result" && p.callID === (call.kind === "tool-call" ? call.callID : ""));
      if (call.kind === "tool-call" && call.callID === "call_3") {
        expect(result).toBeUndefined();
      } else {
        expect(result).toBeDefined();
      }
    }
  });

  test("completed tool joins content text; error tool prefers state.error", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const parts = docs[0]!.messages.find((m) => m.id === "m-assistant")!.parts;
    const ok = parts.find((p) => p.kind === "tool-result" && p.callID === "call_1");
    const err = parts.find((p) => p.kind === "tool-result" && p.callID === "call_2");
    expect(ok && ok.kind === "tool-result" && ok.output).toBe("file1\nfile2");
    expect(ok && ok.kind === "tool-result" && ok.isError).toBe(false);
    expect(err && err.kind === "tool-result" && err.output).toBe("boom");
    expect(err && err.kind === "tool-result" && err.isError).toBe(true);
  });

  test("unknown content part maps to kind:'unknown' without throwing", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const parts = docs[0]!.messages.find((m) => m.id === "m-assistant")!.parts;
    const unknown = parts.find((p) => p.kind === "unknown");
    expect(unknown && unknown.kind === "unknown" && unknown.type).toBe("weird");
  });

  test("assistant finish/cost/tokens append one trailing step-finish", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const parts = docs[0]!.messages.find((m) => m.id === "m-assistant")!.parts;
    const last = parts[parts.length - 1]!;
    expect(last.kind).toBe("step-finish");
    if (last.kind === "step-finish" && last.meta !== null) {
      const meta = JSON.parse(last.meta);
      expect(meta.finish).toBe("stop");
      expect(meta.cost).toBe(0.01);
      expect(meta.tokens).toEqual({ input: 10, output: 5 });
    }
  });

  test("user text + files → text part then file parts (basename from url)", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const parts = docs[0]!.messages.find((m) => m.id === "m-user")!.parts;
    expect(parts[0]).toEqual({ kind: "text", text: "Hello alpha" });
    expect(parts[1]).toEqual({ kind: "file", name: "a.txt", mime: "text/plain" });
    expect(parts[2]).toEqual({ kind: "file", name: "z.png", mime: null });
  });

  test("empty user message yields an empty parts array", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const msg = docs[0]!.messages.find((m) => m.id === "m-empty")!;
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([]);
  });

  test("malformed JSON data never throws → unknown part", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const msg = docs[0]!.messages.find((m) => m.id === "m-malformed")!;
    expect(msg.parts.some((p) => p.kind === "unknown")).toBe(true);
  });

  test("unknown message type → role system + unknown part", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const msg = docs[0]!.messages.find((m) => m.id === "m-unknown-type")!;
    expect(msg.role).toBe("system");
    expect(msg.parts[0]!.kind).toBe("unknown");
  });
});

describe("lifecycle mappings", () => {
  test("synthetic/idle/model-switched/agent-switched/compaction → status parts", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(loadSessionDoc$(db, "s1"));
    db.close();
    const byId = (id: string) => docs[0]!.messages.find((m) => m.id === id)!;

    expect(byId("m-synthetic").role).toBe("system");
    expect(byId("m-synthetic").parts[0]).toEqual({ kind: "status", type: "synthetic", detail: "synthetic note" });
    expect(byId("m-idle").parts[0]).toEqual({ kind: "status", type: "idle", detail: "idled" });
    expect(byId("m-model").parts[0]).toEqual({ kind: "status", type: "model-switched", detail: "gpt-x (was gpt-w)" });
    expect(byId("m-agent").parts[0]).toEqual({ kind: "status", type: "agent-switched", detail: "build (was plan)" });
    expect(byId("m-compact").parts[0]).toEqual({ kind: "status", type: "compaction", detail: "context full" });
  });

  test("message time uses data.time.created, falls back to time_created", () => {
    const base: SessionMessageRow = {
      id: "x", session_id: "s", type: "idle", seq: 1, time_created: 777, time_updated: 777, data: null,
    };
    const withData = parseSessionMessage(base);
    expect(withData.time).toBe(new Date(777).toISOString());
    const explicit = parseSessionMessage({ ...base, data: JSON.stringify({ time: { created: 999 } }) });
    expect(explicit.time).toBe(new Date(999).toISOString());
  });
});

describe("listSessions$", () => {
  test("orders by time_updated DESC and counts messages / resolves preview", async () => {
    const db = openDatabase(FIXTURE_DB);
    const lists = await collect(listSessions$(db, {}));
    db.close();
    expect(lists.length).toBe(1);
    const rows = lists[0]!;
    expect(rows.map((r) => r.id)).toEqual(["s2", "s3", "s1", "s4"]);
    const s1 = rows.find((r) => r.id === "s1")!;
    expect(s1.messageCount).toBe(10);
    expect(s1.preview).toBe("Hello alpha");
    const s3 = rows.find((r) => r.id === "s3")!;
    expect(s3.preview).toBeNull();
    expect(s3.messageCount).toBe(0);
    expect(s3.updatedAt).toBe(new Date(4000).toISOString());
  });

  test("query filters case-insensitive LIKE on title OR directory", async () => {
    const db = openDatabase(FIXTURE_DB);
    const byTitle = await collect(listSessions$(db, { query: "alpha" }));
    const byDir = await collect(listSessions$(db, { query: "GAMMA" }));
    db.close();
    expect(byTitle[0]!.map((r) => r.id)).toEqual(["s1"]);
    expect(byDir[0]!.map((r) => r.id)).toEqual(["s3"]);
  });

  test("limit clamps to [1,200] and default 20", async () => {
    const db = openDatabase(FIXTURE_DB);
    const limited = await collect(listSessions$(db, { limit: 2 }));
    const capped = await collect(listSessions$(db, { limit: 9999 }));
    db.close();
    expect(limited[0]!.length).toBe(2);
    expect(capped[0]!.length).toBe(4);
  });

  test("createChroniclerDb wires config → observable facade", async () => {
    const db = createChroniclerDb(loadEnv({ OPENCODE_DB_PATH: FIXTURE_DB }));
    const lists = await collect(db.listSessions({ query: "beta" }));
    const docs = await collect(db.loadSessionDoc("s2"));
    db.raw.close();
    expect(lists[0]!.map((r) => r.id)).toEqual(["s2"]);
    expect(docs[0]!.meta.id).toBe("s2");
  });
});
