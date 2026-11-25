import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observable } from "rxjs";
import { loadBoundedDoc$ } from "../src/budget/window";
import { loadBoundedSessions$ } from "../src/budget/table";
import {
  countSessions$,
  listSessionPage$,
  loadMessagePage$,
  loadSessionMetaCount$,
} from "../src/db/queries";
import { createChroniclerDb, openDatabase } from "../src/db/opencode-db";
import { loadEnv } from "../src/config/env";
import { parseSessionMessage, parseSessionMeta, toIso } from "../src/db/v2parse";
import type { SessionMessageRow } from "../src/db/rows";
import type { BoundedDoc } from "../src/domain/types";
import { deriveRenderOptions } from "../src/limits";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "chronicler-db-"));
const FIXTURE_DB = join(FIXTURE_DIR, "fixture.db");
const WHOLE = 2_000_000;

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

function readDoc(db: Database, id: string, direction: "head" | "tail" = "head"): Observable<BoundedDoc> {
  return loadBoundedDoc$(db, id, {
    direction,
    tokenBudget: WHOLE,
    renderOptions: deriveRenderOptions(WHOLE, true),
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
    { $id: "s5", $project_id: "p1", $parent_id: null, $directory: "/home/x/alpha2", $title: "Alpha two", $version: "1.18.18", $time_created: 1600, $time_updated: 6000 },
    { $id: "s6", $project_id: "p1", $parent_id: null, $directory: "/home/x/alpha/sub", $title: "Alpha sub", $version: "1.18.18", $time_created: 1700, $time_updated: 7000 },
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

describe("loadBoundedDoc$ (head, whole session)", () => {
  test("orders messages by seq ONLY (sparse seq preserved)", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(readDoc(db, "s1"));
    db.close();
    expect(docs.length).toBe(1);
    const seqIds = ["m-user", "m-assistant", "m-synthetic", "m-idle", "m-model", "m-agent", "m-compact", "m-malformed", "m-unknown-type", "m-empty"];
    expect(docs[0]!.messages.map((m) => m.id)).toEqual(seqIds);
    expect(docs[0]!.messages.map((m) => m.seq)).toEqual([4, 10, 20, 30, 40, 50, 60, 65, 70, 681]);
    expect(docs[0]!.totalMessages).toBe(10);
  });

  test("not-found yields an empty Observable (0 emissions)", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(readDoc(db, "does-not-exist"));
    db.close();
    expect(docs).toEqual([]);
  });

  test("assistant: tool-call/tool-result pairing with equal callID", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(readDoc(db, "s1"));
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
    const docs = await collect(readDoc(db, "s1"));
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
    const docs = await collect(readDoc(db, "s1"));
    db.close();
    const parts = docs[0]!.messages.find((m) => m.id === "m-assistant")!.parts;
    const unknown = parts.find((p) => p.kind === "unknown");
    expect(unknown && unknown.kind === "unknown" && unknown.type).toBe("weird");
  });

  test("assistant finish/cost/tokens append one trailing step-finish", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(readDoc(db, "s1"));
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
    const docs = await collect(readDoc(db, "s1"));
    db.close();
    const parts = docs[0]!.messages.find((m) => m.id === "m-user")!.parts;
    expect(parts[0]).toEqual({ kind: "text", text: "Hello alpha" });
    expect(parts[1]).toEqual({ kind: "file", name: "a.txt", mime: "text/plain" });
    expect(parts[2]).toEqual({ kind: "file", name: "z.png", mime: null });
  });

  test("empty user message yields an empty parts array", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(readDoc(db, "s1"));
    db.close();
    const msg = docs[0]!.messages.find((m) => m.id === "m-empty")!;
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([]);
  });

  test("malformed JSON data never throws → unknown part", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(readDoc(db, "s1"));
    db.close();
    const msg = docs[0]!.messages.find((m) => m.id === "m-malformed")!;
    expect(msg.parts.some((p) => p.kind === "unknown")).toBe(true);
  });

  test("unknown message type → role system + unknown part", async () => {
    const db = openDatabase(FIXTURE_DB);
    const docs = await collect(readDoc(db, "s1"));
    db.close();
    const msg = docs[0]!.messages.find((m) => m.id === "m-unknown-type")!;
    expect(msg.role).toBe("system");
    expect(msg.parts[0]!.kind).toBe("unknown");
  });
});

describe("loadSessionMetaCount$", () => {
  test("returns meta plus the true message count", async () => {
    const db = openDatabase(FIXTURE_DB);
    const values = await collect(loadSessionMetaCount$(db, "s1"));
    db.close();
    expect(values.length).toBe(1);
    expect(values[0]!.meta.id).toBe("s1");
    expect(values[0]!.totalMessages).toBe(10);
  });

  test("unknown id yields no emissions", async () => {
    const db = openDatabase(FIXTURE_DB);
    const values = await collect(loadSessionMetaCount$(db, "nope"));
    db.close();
    expect(values).toEqual([]);
  });
});

describe("loadMessagePage$", () => {
  test("forward pages ascend and resume after the last seq", async () => {
    const db = openDatabase(FIXTURE_DB);
    const first = await collect(loadMessagePage$(db, "s1", { direction: "forward", limit: 3 }));
    const next = await collect(loadMessagePage$(db, "s1", { direction: "forward", cursor: 20, limit: 3 }));
    db.close();
    expect(first[0]!.map((m) => m.seq)).toEqual([4, 10, 20]);
    expect(next[0]!.map((m) => m.seq)).toEqual([30, 40, 50]);
  });

  test("backward pages are returned ascending and resume before the first seq", async () => {
    const db = openDatabase(FIXTURE_DB);
    const page = await collect(loadMessagePage$(db, "s1", { direction: "backward", cursor: 70, limit: 3 }));
    const older = await collect(loadMessagePage$(db, "s1", { direction: "backward", cursor: 50, limit: 2 }));
    db.close();
    expect(page[0]!.map((m) => m.seq)).toEqual([50, 60, 65]);
    expect(older[0]!.map((m) => m.seq)).toEqual([30, 40]);
  });
});

describe("listSessionPage$ / countSessions$", () => {
  test("orders by time_updated DESC and resolves previews and counts", async () => {
    const db = openDatabase(FIXTURE_DB);
    const pages = await collect(listSessionPage$(db, {}));
    db.close();
    const rows = pages[0]!;
    expect(rows.map((r) => r.summary.id)).toEqual(["s6", "s5", "s2", "s3", "s1", "s4"]);
    const s1 = rows.find((r) => r.summary.id === "s1")!.summary;
    expect(s1.messageCount).toBe(10);
    expect(s1.preview).toBe("Hello alpha");
    const s3 = rows.find((r) => r.summary.id === "s3")!.summary;
    expect(s3.preview).toBeNull();
    expect(s3.messageCount).toBe(0);
    expect(s3.updatedAt).toBe(new Date(4000).toISOString());
  });

  test("query filters case-insensitive LIKE on title OR directory", async () => {
    const db = openDatabase(FIXTURE_DB);
    const byTitle = await collect(listSessionPage$(db, { query: "alpha" }));
    const byDir = await collect(listSessionPage$(db, { query: "GAMMA" }));
    db.close();
    expect(byTitle[0]!.map((r) => r.summary.id)).toEqual(["s6", "s5", "s1"]);
    expect(byDir[0]!.map((r) => r.summary.id)).toEqual(["s3"]);
  });

  test("cursor paging continues after the last row without gaps", async () => {
    const db = openDatabase(FIXTURE_DB);
    const first = await collect(listSessionPage$(db, { limit: 2 }));
    const last = first[0]![1]!;
    const second = await collect(
      listSessionPage$(db, {
        limit: 2,
        before: { timeUpdated: last.sortMs!, id: last.summary.id },
      }),
    );
    db.close();
    expect(first[0]!.map((r) => r.summary.id)).toEqual(["s6", "s5"]);
    expect(second[0]!.map((r) => r.summary.id)).toEqual(["s2", "s3"]);
  });

  test("countSessions$ respects the filter", async () => {
    const db = openDatabase(FIXTURE_DB);
    const all = await collect(countSessions$(db, {}));
    const filtered = await collect(countSessions$(db, { query: "beta" }));
    db.close();
    expect(all[0]).toBe(6);
    expect(filtered[0]).toBe(1);
  });
});

describe("session_directory filter", () => {
  test("matches exactly — no subtree, no sibling prefix", async () => {
    const db = openDatabase(FIXTURE_DB);
    const exact = await collect(listSessionPage$(db, { session_directory: "/home/x/alpha" }));
    const sibling = await collect(listSessionPage$(db, { session_directory: "/home/x/alpha2" }));
    const parent = await collect(listSessionPage$(db, { session_directory: "/home/x" }));
    db.close();
    expect(exact[0]!.map((r) => r.summary.id)).toEqual(["s1"]);
    expect(sibling[0]!.map((r) => r.summary.id)).toEqual(["s5"]);
    expect(parent[0]).toEqual([]);
  });

  test("normalizes trailing slashes and is case-sensitive", async () => {
    const db = openDatabase(FIXTURE_DB);
    const slash = await collect(listSessionPage$(db, { session_directory: "/home/x/alpha/" }));
    const deepSlash = await collect(listSessionPage$(db, { session_directory: "/home/x/alpha///" }));
    const upper = await collect(listSessionPage$(db, { session_directory: "/HOME/X/ALPHA" }));
    db.close();
    expect(slash[0]!.map((r) => r.summary.id)).toEqual(["s1"]);
    expect(deepSlash[0]!.map((r) => r.summary.id)).toEqual(["s1"]);
    expect(upper[0]).toEqual([]);
  });

  test("treats like wildcards literally", async () => {
    const db = openDatabase(FIXTURE_DB);
    const percent = await collect(listSessionPage$(db, { session_directory: "/home/x/%" }));
    const underscore = await collect(listSessionPage$(db, { session_directory: "/home/x/alpha_" }));
    db.close();
    expect(percent[0]).toEqual([]);
    expect(underscore[0]).toEqual([]);
  });

  test("composes with query (AND) and with count", async () => {
    const db = openDatabase(FIXTURE_DB);
    const composed = await collect(
      listSessionPage$(db, { session_directory: "/home/x/alpha", query: "alpha" }),
    );
    const counts = await collect(countSessions$(db, { session_directory: "/home/x/alpha" }));
    db.close();
    expect(composed[0]!.map((r) => r.summary.id)).toEqual(["s1"]);
    expect(counts[0]).toBe(1);
  });

  test("absent, empty and whitespace all mean no filter", async () => {
    const db = openDatabase(FIXTURE_DB);
    const absent = await collect(listSessionPage$(db, {}));
    const empty = await collect(listSessionPage$(db, { session_directory: "" }));
    const blank = await collect(listSessionPage$(db, { session_directory: "   " }));
    db.close();
    expect(absent[0]!.length).toBe(6);
    expect(empty[0]!.length).toBe(6);
    expect(blank[0]!.length).toBe(6);
  });

  test("budgeted listing keeps totalRows in agreement with the filter", async () => {
    const db = openDatabase(FIXTURE_DB);
    const pages = await collect(
      loadBoundedSessions$(db, { tokenBudget: 1_000, session_directory: "/home/x/alpha" }),
    );
    db.close();
    expect(pages[0]!.totalRows).toBe(1);
    expect(pages[0]!.rows.map((r) => r.id)).toEqual(["s1"]);
  });
});

describe("loadBoundedSessions$", () => {
  test("returns every row when the budget is ample", async () => {
    const db = openDatabase(FIXTURE_DB);
    const pages = await collect(loadBoundedSessions$(db, { tokenBudget: 1_000 }));
    db.close();
    expect(pages[0]!.totalRows).toBe(6);
    expect(pages[0]!.rows.map((r) => r.id)).toEqual(["s6", "s5", "s2", "s3", "s1", "s4"]);
    expect(pages[0]!.estimatedTokens).toBeGreaterThan(0);
  });

  test("stops at the budget boundary and reports the total", async () => {
    const db = openDatabase(FIXTURE_DB);
    const pages = await collect(loadBoundedSessions$(db, { tokenBudget: 1_000 }));
    db.close();
    expect(pages[0]!.rows.length).toBeLessThanOrEqual(pages[0]!.totalRows);
  });
});

describe("createChroniclerDb wiring", () => {
  test("config → observable facade for docs and lists", async () => {
    const db = createChroniclerDb(loadEnv({ OPENCODE_DB_PATH: FIXTURE_DB }));
    const tokenBudget = WHOLE;
    const docs = await collect(
      db.loadBoundedDoc("s2", {
        direction: "head",
        tokenBudget,
        renderOptions: deriveRenderOptions(tokenBudget, true),
      }),
    );
    const lists = await collect(db.loadBoundedSessions({ query: "beta", tokenBudget: 1_000 }));
    db.raw.close();
    expect(docs[0]!.meta.id).toBe("s2");
    expect(lists[0]!.rows.map((r) => r.id)).toEqual(["s2"]);
  });
});

test("lifecycle mappings stay intact", async () => {
  const db = openDatabase(FIXTURE_DB);
  const docs = await collect(readDoc(db, "s1"));
  db.close();
  const byId = (id: string) => docs[0]!.messages.find((m) => m.id === id)!;

  expect(byId("m-synthetic").role).toBe("system");
  expect(byId("m-synthetic").parts[0]).toEqual({ kind: "status", type: "synthetic", detail: "synthetic note" });
  expect(byId("m-idle").parts[0]).toEqual({ kind: "status", type: "idle", detail: "idled" });
  expect(byId("m-model").parts[0]).toEqual({ kind: "status", type: "model-switched", detail: "gpt-x (was gpt-w)" });
  expect(byId("m-agent").parts[0]).toEqual({ kind: "status", type: "agent-switched", detail: "build (was plan)" });
  expect(byId("m-compact").parts[0]).toEqual({ kind: "status", type: "compaction", detail: "context full" });

  const base: SessionMessageRow = {
    id: "x", session_id: "s", type: "idle", seq: 1, time_created: 777, time_updated: 777, data: null,
  };
  expect(parseSessionMessage(base).time).toBe(new Date(777).toISOString());
  expect(parseSessionMessage({ ...base, data: JSON.stringify({ time: { created: 999 } }) }).time).toBe(
    new Date(999).toISOString(),
  );
});
