import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnv } from "../src/config/env";
import { createChroniclerDb, type ChroniclerDb } from "../src/db/opencode-db";
import { createLogger } from "../src/log";
import { createHttpApp, type HttpApp } from "../src/mcp/http";
import { listSessionsHandler } from "../src/mcp/tools/list-sessions";
import { readSessionHandler } from "../src/mcp/tools/read-session";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "chronicler-mcp-"));
const FIXTURE_DB = join(FIXTURE_DIR, "fixture.db");
const TITLE = "Alpha Session";

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
  db.prepare(
    `INSERT INTO session_v2
       (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, time_created, time_updated)
     VALUES ('s1', 'p1', NULL, NULL, NULL, '/home/x/alpha', NULL, $title, '1.18.18', 1000, 3000)`,
  ).run({ $title: TITLE });
  const insertMessage = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES ($id, $session_id, $type, $seq, $time_created, $time_updated, $data)`,
  );
  insertMessage.run({
    $id: "m-user",
    $session_id: "s1",
    $type: "user",
    $seq: 1,
    $time_created: 1000,
    $time_updated: 1000,
    $data: JSON.stringify({ text: "Hello alpha", time: { created: 1000 } }),
  });
  insertMessage.run({
    $id: "m-assistant",
    $session_id: "s1",
    $type: "assistant",
    $seq: 2,
    $time_created: 1100,
    $time_updated: 1100,
    $data: JSON.stringify({ content: [{ type: "text", text: "working" }, { type: "reasoning", text: "internal thinking" }], time: { created: 1100 } }),
  });
  db.close();
}

let db: ChroniclerDb;
let app: HttpApp;
const log = createLogger("error");

beforeAll(() => {
  buildFixture();
  const config = { ...loadEnv({ OPENCODE_DB_PATH: FIXTURE_DB }), host: "127.0.0.1", port: 0 };
  db = createChroniclerDb(config);
  app = createHttpApp(config, db, log);
});

afterAll(async () => {
  await app.stop();
  db.raw.close();
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("fixture isolation", () => {
  test("fixture lives under the OS temp dir and never touches the real db", () => {
    expect(FIXTURE_DB.startsWith(tmpdir())).toBe(true);
    expect(FIXTURE_DB.includes(".local/share/opencode")).toBe(false);
  });
});

describe("GET /health", () => {
  test("responds 200 with the frozen JSON body", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "opencode-chronicler" });
  });

  test("unknown route responds 404 JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("read_session handler", () => {
  test("returns markdown containing the fixture session title", async () => {
    const result = await readSessionHandler(db)({ session_id: "s1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain(TITLE);
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toContain("## user");
  });

  test("unknown id ⇒ isError:true 'Session not found: {id}'", async () => {
    const result = await readSessionHandler(db)({ session_id: "does-not-exist" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toBe("Session not found: does-not-exist");
  });

  test("reasoning/thinking blocks are never rendered", async () => {
    const result = await readSessionHandler(db)({ session_id: "s1" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("Reasoning");
    expect(text).not.toContain("internal thinking");
  });
});

describe("list_sessions handler", () => {
  test("returns a table with a row for the fixture session", async () => {
    const result = await listSessionsHandler(db)({});
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text.startsWith("| ID |")).toBe(true);
    expect(text).toContain("s1");
  });
});

describe("stateless MCP over HTTP", () => {
  test("a real client lists tools and calls read_session", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${app.port}/mcp`),
    );
    const client = new Client({ name: "chronicler-mcp-test", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_sessions", "read_session"]);

    const result = await client.callTool({ name: "read_session", arguments: { session_id: "s1" } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    expect(text).toContain(TITLE);

    await client.close();
  });

  test("two sequential requests both succeed (fresh transport per request)", async () => {
    const first = await callOverHttp("read_session", { session_id: "s1" });
    const second = await callOverHttp("read_session", { session_id: "s1" });
    expect(first).toContain(TITLE);
    expect(second).toContain(TITLE);
  });
});

async function callOverHttp(name: string, args: Record<string, unknown>): Promise<string> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${app.port}/mcp`),
  );
  const client = new Client({ name: "chronicler-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
}
