import { describe, test, expect } from "bun:test";
import { DEFAULT_RENDER_OPTIONS } from "../src/domain/types";
import type {
  BoundedDoc,
  ChroniclerPart,
  RenderOptions,
  SessionDoc,
  SessionSummary,
} from "../src/domain/types";
import { TOKEN_BUDGET_DEFAULTS } from "../src/limits";
import { renderPart, longestBacktickRun, truncate } from "../src/render/parts";
import { renderBoundedDoc } from "../src/render/session-md";
import { renderSessionsTable } from "../src/render/sessions-table";

const OPTS: RenderOptions = { includeToolOutput: true, maxPartChars: 2000 };

function meta(overrides: Partial<SessionDoc["meta"]> = {}): SessionDoc["meta"] {
  return {
    id: "ses_1",
    title: "Demo",
    directory: "/tmp/demo",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
    projectID: "proj",
    parentID: null,
    version: "1.18.18",
    ...overrides,
  };
}

function doc(parts: ChroniclerPart[] = [], overrides: Partial<SessionDoc["meta"]> = {}): BoundedDoc {
  return {
    meta: meta(overrides),
    messages: [{ id: "msg_1", seq: 1, role: "user", time: "2026-01-01T00:00:00Z", parts }],
    totalMessages: 1,
    direction: "head",
    tokenBudget: TOKEN_BUDGET_DEFAULTS.tail,
    truncatedBoundary: false,
  };
}

describe("renderPart — every kind", () => {
  test("renders text as-is", () => {
    expect(renderPart({ kind: "text", text: "hello world" }, OPTS)).toBe("hello world");
  });

  test("reasoning is suppressed — renders empty string, no label", () => {
    const out = renderPart({ kind: "reasoning", text: "think" }, OPTS);
    expect(out).toBe("");
    expect(out).not.toContain("Reasoning");
    expect(renderPart({ kind: "reasoning", text: null } as unknown as ChroniclerPart, OPTS)).toBe("");
  });

  test("renders tool-call with tool, callID and json fence", () => {
    const out = renderPart(
      { kind: "tool-call", tool: "read", callID: "call_1", args: '{"p":"x"}' },
      OPTS,
    );
    expect(out).toContain("**Tool: read** (`call_1`)");
    expect(out).toContain('```json\n{"p":"x"}\n```');
  });

  test("renders tool-result with normal and error labels", () => {
    const ok = renderPart({ kind: "tool-result", callID: "c", output: "fine", isError: false }, OPTS);
    expect(ok).toContain("**Output:**");
    const err = renderPart({ kind: "tool-result", callID: "c", output: "boom", isError: true }, OPTS);
    expect(err).toContain("**Output (error):**");
  });

  test("step-start renders empty string", () => {
    expect(renderPart({ kind: "step-start", meta: null }, OPTS)).toBe("");
  });

  test("step-finish renders an italic line with meta", () => {
    expect(renderPart({ kind: "step-finish", meta: "cost=1" }, OPTS)).toBe("*step finished — cost=1*");
    expect(renderPart({ kind: "step-finish", meta: null }, OPTS)).toBe("*step finished*");
  });

  test("status renders warning line and tolerates null detail", () => {
    expect(renderPart({ kind: "status", type: "idle", detail: "waiting" }, OPTS)).toBe(
      "⚠ **idle** — waiting",
    );
    expect(renderPart({ kind: "status", type: "idle", detail: null }, OPTS)).toBe("⚠ **idle** — ");
  });

  test("file renders name and optional mime", () => {
    expect(renderPart({ kind: "file", name: "a.png", mime: "image/png" }, OPTS)).toBe(
      "📎 **a.png** (image/png)",
    );
    expect(renderPart({ kind: "file", name: null, mime: null }, OPTS)).toBe("📎 **file**");
  });

  test("every declared kind renders a string without throwing", () => {
    const kinds: ChroniclerPart[] = [
      { kind: "text", text: "t" },
      { kind: "reasoning", text: "r" },
      { kind: "tool-call", tool: "t", callID: "c", args: "{}" },
      { kind: "tool-result", callID: "c", output: "o", isError: false },
      { kind: "step-start", meta: null },
      { kind: "step-finish", meta: null },
      { kind: "status", type: "s", detail: null },
      { kind: "file", name: "f", mime: null },
      { kind: "unknown", type: "u", raw: "raw" },
    ];
    for (const part of kinds) {
      expect(typeof renderPart(part, OPTS)).toBe("string");
    }
  });
});

describe("renderPart — safety", () => {
  test("unknown kind string renders fallback and never throws", () => {
    const out = renderPart({ kind: "mystery", raw: "payload" } as unknown as ChroniclerPart, OPTS);
    expect(out).toContain("unknown part (mystery)");
    expect(out).toContain("payload");
  });

  test("malformed shapes (null, primitive, missing fields) never throw", () => {
    expect(() => renderPart(null as unknown as ChroniclerPart, OPTS)).not.toThrow();
    expect(() => renderPart(42 as unknown as ChroniclerPart, OPTS)).not.toThrow();
    expect(() =>
      renderPart({ kind: "tool-call" } as unknown as ChroniclerPart, OPTS),
    ).not.toThrow();
    expect(renderPart(null as unknown as ChroniclerPart, OPTS)).toContain("unknown part");
  });

  test("includeToolOutput=false hides tool-result output entirely", () => {
    const opts: RenderOptions = { includeToolOutput: false, maxPartChars: 2000 };
    const out = renderPart({ kind: "tool-result", callID: "c", output: "secret", isError: false }, opts);
    expect(out).toBe("");
    expect(out).not.toContain("secret");
  });

  test("fence escalates to outrun backtick runs inside the content", () => {
    const content = "before ``` after";
    const fenced = renderPart({ kind: "unknown", type: "u", raw: content }, OPTS);
    expect(longestBacktickRun(content)).toBe(3);
    expect(fenced).toContain("````\n" + content + "\n````");
  });

  test("truncation cuts content and appends the marker with the removed count", () => {
    const opts: RenderOptions = { includeToolOutput: true, maxPartChars: 5 };
    const out = renderPart({ kind: "text", text: "0123456789" }, opts);
    expect(out).toBe("01234\n…[truncated 5 more chars]");
    expect(truncate("abcdef", 6)).toBe("abcdef");
  });
});

describe("renderBoundedDoc", () => {
  test("renders full metadata header, message count and token line", () => {
    const out = renderBoundedDoc(doc([{ kind: "text", text: "hi" }]), OPTS);
    expect(out).toContain("# Demo");
    expect(out).toContain("- **ID**: `ses_1`");
    expect(out).toContain("- **Directory**: /tmp/demo");
    expect(out).toContain("- **Created**: 2026-01-01T00:00:00Z");
    expect(out).toContain("- **Updated**: 2026-01-01T01:00:00Z");
    expect(out).toContain("- **Project**: proj");
    expect(out).toContain("- **Parent**: —");
    expect(out).toContain("- **Version**: 1.18.18");
    expect(out).toContain("- **Messages**: 1");
    expect(out).toMatch(/- \*\*Tokens\*\*: ≈[\d,]+ of 150,000 budget/);
    expect(out).toContain("\n---\n");
    expect(out).toContain("hi");
  });

  test("falls back to id when title is null, and em-dash for null metadata", () => {
    const out = renderBoundedDoc(
      doc([], { title: null, directory: null, createdAt: null, updatedAt: null, projectID: null, version: null }),
      OPTS,
    );
    expect(out).toContain("# ses_1");
    expect(out).toContain("- **Directory**: —");
    expect(out).toContain("- **Created**: —");
    expect(out).toContain("- **Updated**: —");
    expect(out).toContain("- **Project**: —");
    expect(out).toContain("- **Version**: —");
  });

  test("appends subagent marker when parentID is set", () => {
    const out = renderBoundedDoc(doc([], { parentID: "ses_parent" }), OPTS);
    expect(out).toContain("- **Parent**: ses_parent — subagent session");
  });

  test("zero messages emits the placeholder without notices", () => {
    const out = renderBoundedDoc({ ...doc([]), messages: [], totalMessages: 0 }, OPTS);
    expect(out.endsWith("_No messages recorded._")).toBe(true);
    expect(out).not.toContain("omitted");
  });

  test("message heading falls back to 'time unknown' and keeps empty-part messages", () => {
    const out = renderBoundedDoc(
      {
        ...doc([]),
        messages: [
          { id: "m1", seq: 1, role: "assistant", time: null, parts: [] },
          { id: "m2", seq: 2, role: "system", time: null, parts: [{ kind: "step-start", meta: null }] },
        ],
        totalMessages: 2,
      },
      OPTS,
    );
    expect(out).toContain("## assistant — time unknown");
    expect(out).toContain("## system — time unknown");
    expect(out).toContain("- **Messages**: 2");
  });

  test("joins multiple rendered parts with a blank line", () => {
    const out = renderBoundedDoc(doc([{ kind: "text", text: "one" }, { kind: "text", text: "two" }]), OPTS);
    expect(out).toContain("## user — 2026-01-01T00:00:00Z\n\none\n\ntwo");
  });

  test("reasoning parts never appear in session output", () => {
    const out = renderBoundedDoc(doc([{ kind: "reasoning", text: "secret thinking" }]), OPTS);
    expect(out).not.toContain("Reasoning");
    expect(out).not.toContain("secret thinking");
  });

  test("hidden reasoning does not shift neighbouring parts", () => {
    const withReasoning = renderBoundedDoc(
      doc([
        { kind: "text", text: "one" },
        { kind: "reasoning", text: "think" },
        { kind: "text", text: "two" },
      ]),
      OPTS,
    );
    const without = renderBoundedDoc(doc([{ kind: "text", text: "one" }, { kind: "text", text: "two" }]), OPTS);
    expect(withReasoning).toBe(without);
  });

  test("head omission reads as 'showing the first N'", () => {
    const out = renderBoundedDoc(
      {
        ...doc([{ kind: "text", text: "one" }]),
        messages: [
          { id: "m1", seq: 1, role: "user", time: "2026-01-01T00:00:00Z", parts: [{ kind: "text", text: "one" }] },
          { id: "m2", seq: 2, role: "assistant", time: "2026-01-01T00:00:01Z", parts: [{ kind: "text", text: "two" }] },
        ],
        totalMessages: 12,
        direction: "head",
      },
      OPTS,
    );
    expect(out).toContain("- **Messages**: 12 (showing first 2)");
    expect(out).toContain("_… 10 later messages omitted — showing the first 2 of 12. …_");
  });

  test("tail omission reads as 'showing the last N'", () => {
    const out = renderBoundedDoc(
      {
        ...doc([{ kind: "text", text: "one" }]),
        messages: [
          { id: "m1", seq: 1, role: "user", time: "2026-01-01T00:00:00Z", parts: [{ kind: "text", text: "one" }] },
          { id: "m2", seq: 2, role: "assistant", time: "2026-01-01T00:00:01Z", parts: [{ kind: "text", text: "two" }] },
        ],
        totalMessages: 12,
        direction: "tail",
      },
      OPTS,
    );
    expect(out).toContain("- **Messages**: 12 (showing last 2)");
    expect(out).toContain("_… 10 earlier messages omitted — showing the last 2 of 12. …_");
  });

  test("boundary truncation is announced and shrinks that message's part cap", () => {
    const payload = "q".repeat(50_000);
    const out = renderBoundedDoc(
      {
        ...doc([{ kind: "text", text: payload }]),
        tokenBudget: 1_000,
        truncatedBoundary: true,
      },
      { includeToolOutput: true, maxPartChars: 28_000 },
    );
    expect(out).toContain("_… one message was truncated to fit the ≈1,000-token budget. …_");
    expect(out).toContain("[truncated");
    expect(out).not.toContain(payload);
  });
});

describe("renderSessionsTable", () => {
  const base: SessionSummary = {
    id: "ses_1",
    title: "T",
    directory: "/d",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 3,
    preview: "hello",
  };

  test("renders the frozen header and a row", () => {
    const out = renderSessionsTable([base]);
    expect(out.split("\n")[0]).toBe("| ID | Title | Msgs | Updated | Directory | Preview |");
    expect(out.split("\n")[1]).toBe("|---|---|---|---|---|---|");
    expect(out).toContain("| ses_1 | T | 3 | 2026-01-01T00:00:00Z | /d | hello |");
  });

  test("empty input yields the frozen single line", () => {
    expect(renderSessionsTable([])).toBe("No sessions found.");
  });

  test("escapes pipes, collapses newlines, and uses em-dash for nulls", () => {
    const out = renderSessionsTable([
      { ...base, title: "a|b", directory: null, updatedAt: null, preview: "x\ny|z" },
    ]);
    const row = out.split("\n")[2] as string;
    expect(row).toContain("| a\\|b |");
    expect(row).toContain("| — |");
    expect(row).toContain("| x y\\|z |");
    expect(row).not.toContain("\n");
  });

  test("preview is trimmed to 80 chars", () => {
    const out = renderSessionsTable([{ ...base, preview: "p".repeat(120) }]);
    const row = out.split("\n")[2] as string;
    const previewCell = row.split(" | ").at(-1)?.replace(/ \|$/, "") ?? "";
    expect(previewCell.length).toBe(80);
  });

  test("null preview renders as an empty cell", () => {
    const out = renderSessionsTable([{ ...base, preview: null }]);
    expect(out.split("\n")[2]?.endsWith("|  |")).toBe(true);
  });

  test("options add the omission notice and the token footer", () => {
    const out = renderSessionsTable([base], {
      totalRows: 10,
      estimatedTokens: 980,
      tokenBudget: 1_000,
    });
    expect(out).toContain("_… 9 older sessions omitted — showing the newest 1 of 10. …_");
    expect(out).toContain("_≈980 of 1,000 tokens used._");
  });

  test("no options means no notice and no footer", () => {
    const out = renderSessionsTable([base]);
    expect(out).not.toContain("omitted");
    expect(out).not.toContain("tokens used");
  });
});
