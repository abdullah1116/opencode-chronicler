import { DEFAULT_RENDER_OPTIONS } from "../domain/types";
import type { ChroniclerPart, RenderOptions } from "../domain/types";

const FALLBACK_TYPE = "(unknown)";
const ELLIPSIS = "\u2026";

export function longestBacktickRun(content: string): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export function truncate(content: string, max: number): string {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (content.length <= limit) return content;
  return content.slice(0, limit) + `\n${ELLIPSIS}[truncated ${content.length - limit} more chars]`;
}

function fencedBlock(content: string, lang = ""): string {
  const ticks = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

type PartShape = Record<string, unknown>;
type PartHandler = (part: PartShape, opts: RenderOptions) => string;

function fallback(raw: string, type: string | null, opts: RenderOptions): string {
  const label = type !== null && type.length > 0 ? type : FALLBACK_TYPE;
  return `\u2b21 *unknown part (${label})*\n\n${fencedBlock(truncate(raw, opts.maxPartChars))}`;
}

const handlers: Record<string, PartHandler> = {
  text: (part, opts) => {
    const text = asString(part.text);
    return text === null ? fallback(stringify(part), "text", opts) : truncate(text, opts.maxPartChars);
  },

  // Reasoning is intentionally never rendered.
  reasoning: () => "",

  "tool-call": (part, opts) => {
    const tool = asString(part.tool);
    const callID = asString(part.callID);
    const args = asString(part.args);
    if (tool === null || callID === null || args === null) {
      return fallback(stringify(part), "tool-call", opts);
    }
    return `**Tool: ${tool}** (\`${callID}\`)\n\n${fencedBlock(truncate(args, opts.maxPartChars), "json")}`;
  },

  "tool-result": (part, opts) => {
    if (opts.includeToolOutput === false) return "";
    const output = asString(part.output);
    if (output === null) return fallback(stringify(part), "tool-result", opts);
    const label = part.isError === true ? "**Output (error):**" : "**Output:**";
    return `${label}\n\n${fencedBlock(truncate(output, opts.maxPartChars))}`;
  },

  "step-start": () => "",

  "step-finish": (part, opts) => {
    const meta = asString(part.meta);
    if (meta === null || meta.length === 0) return "*step finished*";
    return `*step finished \u2014 ${truncate(meta, opts.maxPartChars)}*`;
  },

  status: (part, opts) => {
    const type = asString(part.type);
    if (type === null) return fallback(stringify(part), "status", opts);
    const detail = asString(part.detail) ?? "";
    return `\u26a0 **${type}** \u2014 ${truncate(detail, opts.maxPartChars)}`;
  },

  file: (part, _opts) => {
    const name = asString(part.name) ?? "file";
    const mime = asString(part.mime);
    return mime === null ? `\ud83d\udcce **${name}**` : `\ud83d\udcce **${name}** (${mime})`;
  },

  unknown: (part, opts) => {
    const type = asString(part.type);
    const raw = asString(part.raw);
    if (type === null || raw === null) return fallback(stringify(part), type ?? "unknown", opts);
    return fallback(raw, type, opts);
  },
};

export function renderPart(part: ChroniclerPart, opts: RenderOptions): string {
  const o = opts ?? DEFAULT_RENDER_OPTIONS;
  const shape = part as unknown;
  if (shape === null || typeof shape !== "object") {
    return fallback(stringify(part), FALLBACK_TYPE, o);
  }
  const record = shape as PartShape;
  const kind = asString(record.kind);
  if (kind === null) return fallback(stringify(record), FALLBACK_TYPE, o);

  const handler = handlers[kind];
  if (handler === undefined) {
    const type = asString(record.type) ?? kind;
    const raw = asString(record.raw) ?? stringify(record);
    return fallback(raw, type, o);
  }
  try {
    return handler(record, o);
  } catch {
    return fallback(stringify(record), kind, o);
  }
}
