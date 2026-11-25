import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnv } from "../../src/config/env";
import { createChroniclerDb, type ChroniclerDb } from "../../src/db/opencode-db";
import { createLogger } from "../../src/log";
import { createHttpApp, type HttpApp } from "../../src/mcp/http";

const REAL_DB = process.env.OPENCODE_DB_PATH ?? join(homedir(), ".local/share/opencode", "opencode.db");
const TARGET_SESSION = process.env.OPENCODE_E2E_SESSION ?? "";

function dbReadable(): boolean {
  try {
    return existsSync(REAL_DB) && statSync(REAL_DB).isFile();
  } catch {
    return false;
  }
}
const HAS_TARGET = TARGET_SESSION.length > 0 && dbReadable();

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

interface FileFingerprint {
  hash: string;
  mtimeMs: number;
  size: number;
}

async function fingerprint(path: string): Promise<FileFingerprint> {
  const stats = statSync(path);
  return { hash: await sha256File(path), mtimeMs: stats.mtimeMs, size: stats.size };
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

let db: ChroniclerDb;
let app: HttpApp;
let client: Client;
const log = createLogger("error");

let before: FileFingerprint;

beforeAll(async () => {
  if (!HAS_TARGET) return;
  before = await fingerprint(REAL_DB);
  const config = { ...loadEnv({ OPENCODE_DB_PATH: REAL_DB }), host: "127.0.0.1", port: 0 };
  db = createChroniclerDb(config);
  app = createHttpApp(config, db, log);
  client = new Client({ name: "chronicler-e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`));
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  if (!HAS_TARGET || client === undefined) return;
  await client.close();
  await app.stop();
  db.raw.close();
}, 120_000);

describe.skipIf(!HAS_TARGET)("e2e: real MCP over HTTP against the real opencode.db", () => {
  test(`real opencode.db is readable at ${REAL_DB}`, () => {
    expect(dbReadable()).toBe(true);
  });

  test("GET /health responds 200 with the frozen body", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "opencode-chronicler" });
  });

  test("handshake: listTools exposes read_session + tail_session + list_sessions", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toContain("read_session");
    expect(names).toContain("tail_session");
    expect(names).toContain("list_sessions");
  });

  test("read_session returns markdown for the configured session id", async () => {
    const result = await client.callTool({
      name: "read_session",
      arguments: { session_id: TARGET_SESSION },
    });
    const text = extractText(result as { content?: Array<{ type: string; text?: string }> });
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toContain("## user");
  });

  test("tail_session returns markdown for the configured session id", async () => {
    const result = await client.callTool({
      name: "tail_session",
      arguments: { session_id: TARGET_SESSION, token_budget: 20_000 },
    });
    const text = extractText(result as { content?: Array<{ type: string; text?: string }> });
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toContain("- **Tokens**: \u2248");
  });

  test("list_sessions(token_budget 1000) returns a budgeted markdown table", async () => {
    const result = await client.callTool({ name: "list_sessions", arguments: { token_budget: 1_000 } });
    const text = extractText(result as { content?: Array<{ type: string; text?: string }> });
    expect(text.startsWith("| ID |")).toBe(true);
    const dataRows = text.split("\n").filter((l) => l.startsWith("| ses_"));
    expect(dataRows.length).toBeGreaterThan(0);
    expect(dataRows.length).toBeLessThanOrEqual(25);
  });

  test("real opencode.db is BYTE-IDENTICAL after the run", async () => {
    const after = await fingerprint(REAL_DB);
    expect(after.hash).toBe(before.hash);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});
