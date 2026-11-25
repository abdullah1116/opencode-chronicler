import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstValueFrom } from "rxjs";
import { loadBoundedDoc$ } from "../src/budget/window";
import { openDatabase } from "../src/db/opencode-db";
import type { BoundedDoc } from "../src/domain/types";
import { bodyBudgetChars, charsForBudget, deriveRenderOptions } from "../src/limits";
import { renderBoundedDoc, renderMessage } from "../src/render/session-md";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "chronicler-budget-"));
const FIXTURE_DB = join(FIXTURE_DIR, "fixture.db");

const UNIFORM_CHARS = 1_000;
const UNIFORM_COUNT = 120;

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
    `INSERT INTO session_v2 (id, directory, title, version, time_created, time_updated)
     VALUES ($id, '/tmp/budget', $title, '1.18.18', 1000, 2000)`,
  );
  insertSession.run({ $id: "uniform", $title: "Uniform" });
  insertSession.run({ $id: "huge", $title: "Huge" });
  insertSession.run({ $id: "tools", $title: "Tools" });

  const insertMessage = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES ($id, $session_id, $type, $seq, $time_created, $time_updated, $data)`,
  );
  for (let i = 1; i <= UNIFORM_COUNT; i++) {
    insertMessage.run({
      $id: `u-${i}`,
      $session_id: "uniform",
      $type: "user",
      $seq: i * 7,
      $time_created: 1000 + i,
      $time_updated: 1000 + i,
      $data: JSON.stringify({ text: "x".repeat(UNIFORM_CHARS), time: { created: 1000 + i } }),
    });
  }
  insertMessage.run({
    $id: "huge-1",
    $session_id: "huge",
    $type: "assistant",
    $seq: 1,
    $time_created: 1000,
    $time_updated: 1000,
    $data: JSON.stringify({
      content: Array.from({ length: 10 }, () => ({ type: "text", text: "y".repeat(50_000) })),
      time: { created: 1000 },
    }),
  });
  for (let i = 1; i <= 10; i++) {
    insertMessage.run({
      $id: `t-${i}`,
      $session_id: "tools",
      $type: "assistant",
      $seq: i,
      $time_created: 1000 + i,
      $time_updated: 1000 + i,
      $data: JSON.stringify({
        content: [
          { type: "text", text: "step" },
          {
            type: "tool",
            id: `call_${i}`,
            name: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              content: [{ type: "text", text: "z".repeat(5_000) }],
            },
          },
        ],
        time: { created: 1000 + i },
      }),
    });
  }
  db.close();
}

async function withDb<T>(run: (db: Database) => Promise<T>): Promise<T> {
  const db = openDatabase(FIXTURE_DB);
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

function load(
  id: string,
  direction: "head" | "tail",
  tokenBudget: number,
  includeToolOutput = true,
): Promise<BoundedDoc> {
  return withDb((db) =>
    firstValueFrom(
      loadBoundedDoc$(db, id, {
        direction,
        tokenBudget,
        renderOptions: deriveRenderOptions(tokenBudget, includeToolOutput),
      }),
    ),
  );
}

beforeAll(() => buildFixture());
afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe("loadBoundedDoc$ — head", () => {
  test("fills from the oldest message and keeps ascending seq order", async () => {
    const budget = 10_000;
    const doc = await load("uniform", "head", budget);
    const renderOptions = deriveRenderOptions(budget, true);
    const perMessage = renderMessage(doc.messages[0]!, renderOptions).length + 2;
    const expected = Math.min(UNIFORM_COUNT, Math.floor(bodyBudgetChars(budget) / perMessage));

    expect(doc.direction).toBe("head");
    expect(doc.totalMessages).toBe(UNIFORM_COUNT);
    expect(doc.messages.length).toBe(expected);
    expect(doc.messages[0]!.id).toBe("u-1");
    expect(doc.messages.map((m) => m.seq)).toEqual(
      doc.messages.map((m) => m.seq).slice().sort((a, b) => a - b),
    );
    expect(doc.truncatedBoundary).toBe(false);
  });

  test("walks every page when the budget covers the whole session", async () => {
    const doc = await load("uniform", "head", 2_000_000);
    expect(doc.messages.length).toBe(UNIFORM_COUNT);
    expect(doc.messages[0]!.id).toBe("u-1");
    expect(doc.messages.at(-1)!.id).toBe(`u-${UNIFORM_COUNT}`);
    expect(new Set(doc.messages.map((m) => m.id)).size).toBe(UNIFORM_COUNT);
  });
});

describe("loadBoundedDoc$ — tail", () => {
  test("fills from the newest message and returns ascending order", async () => {
    const budget = 10_000;
    const doc = await load("uniform", "tail", budget);
    const renderOptions = deriveRenderOptions(budget, true);
    const perMessage = renderMessage(doc.messages[0]!, renderOptions).length + 2;
    const expected = Math.min(UNIFORM_COUNT, Math.floor(bodyBudgetChars(budget) / perMessage));

    expect(doc.messages.length).toBe(expected);
    expect(doc.messages.at(-1)!.id).toBe(`u-${UNIFORM_COUNT}`);
    expect(doc.messages[0]!.id).toBe(`u-${UNIFORM_COUNT - expected + 1}`);
  });

  test("head and tail select the same count for uniform messages", async () => {
    const [head, tail] = await Promise.all([
      load("uniform", "head", 12_345),
      load("uniform", "tail", 12_345),
    ]);
    expect(head.messages.length).toBe(tail.messages.length);
  });

  test("rendered document stays inside the configured budget", async () => {
    const budget = 12_345;
    const doc = await load("uniform", "tail", budget);
    const text = renderBoundedDoc(doc, deriveRenderOptions(budget, true));
    expect(text.length).toBeLessThanOrEqual(charsForBudget(budget) + 200);
    expect(text).toContain("- **Tokens**: \u2248");
  });
});

describe("loadBoundedDoc$ — boundary cases", () => {
  test("a single oversized message is included and flagged for truncation", async () => {
    const budget = 1_000;
    const doc = await load("huge", "tail", budget);
    expect(doc.messages.length).toBe(1);
    expect(doc.truncatedBoundary).toBe(true);
    expect(doc.totalMessages).toBe(1);

    const text = renderBoundedDoc(doc, deriveRenderOptions(budget, true));
    expect(text).toContain("one message was truncated to fit the \u22481,000-token budget");
    expect(text).toContain("[truncated");
    expect(text.length).toBeLessThanOrEqual(charsForBudget(budget) + 200);
  });

  test("include_tool_output=false makes tool-heavy messages cheaper", async () => {
    const [withOutput, withoutOutput] = await Promise.all([
      load("tools", "tail", 2_000, true),
      load("tools", "tail", 2_000, false),
    ]);
    expect(withoutOutput.messages.length).toBeGreaterThan(withOutput.messages.length);
  });

  test("unknown session id errors instead of emitting", async () => {
    await expect(load("does-not-exist", "tail", 10_000)).rejects.toThrow();
  });
});
