// Parsing is defensive: malformed `data` becomes an `unknown` part and never throws.
import type {
  ChroniclerPart,
  MessageRole,
  SessionMessage,
  SessionMeta,
} from "../domain/types";
import type { SessionMessageRow, SessionV2Row } from "./rows";

const UNKNOWN_RAW_CAP = 2000;

export function toIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function unknownPart(type: unknown, value: unknown): ChroniclerPart {
  let raw: string;
  try {
    raw = JSON.stringify(value) ?? String(value);
  } catch {
    raw = String(value);
  }
  return { kind: "unknown", type: stringOrNull(type) ?? "untagged", raw: raw.slice(0, UNKNOWN_RAW_CAP) };
}

function dataColumn(value: unknown): { malformed: boolean; data: Record<string, unknown> | null } {
  if (value === null || value === undefined) return { malformed: false, data: null };
  if (typeof value === "string") {
    if (value.length === 0) return { malformed: false, data: null };
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null) return { malformed: false, data: null };
      const obj = asObject(parsed);
      return obj !== null ? { malformed: false, data: obj } : { malformed: true, data: null };
    } catch {
      return { malformed: true, data: null };
    }
  }
  const obj = asObject(value);
  return obj !== null ? { malformed: false, data: obj } : { malformed: true, data: null };
}

function roleFor(type: unknown): MessageRole {
  if (type === "user") return "user";
  if (type === "assistant") return "assistant";
  return "system";
}

function messageTime(data: Record<string, unknown> | null, row: SessionMessageRow): string | null {
  const time = asObject(data?.time);
  return toIso(time?.created ?? row.time_created);
}

function basename(url: string): string | null {
  const [stripped = ""] = url.split(/[?#]/, 1);
  const segments = stripped.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined ? null : last;
}

function parseFileEntry(entry: unknown): ChroniclerPart {
  const obj = asObject(entry);
  if (!obj) return unknownPart("file", entry);
  const filename = stringOrNull(obj.filename);
  const url = stringOrNull(obj.url);
  const mime = stringOrNull(obj.mime);
  if (filename === null && url === null && mime === null) return unknownPart("file", entry);
  return { kind: "file", name: filename ?? (url !== null ? basename(url) : null), mime };
}

function joinContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const entry of content) {
    const obj = asObject(entry);
    if (obj?.type === "text" && typeof obj.text === "string") out += obj.text;
  }
  return out;
}

function parseToolPart(item: Record<string, unknown>, parts: ChroniclerPart[]): void {
  const callID = stringOrNull(item.id) ?? "";
  const tool = stringOrNull(item.name) ?? "";
  const state = asObject(item.state) ?? {};
  parts.push({
    kind: "tool-call",
    tool,
    callID,
    args: JSON.stringify(state.input ?? {}, null, 2),
  });
  if (state.status === "completed") {
    parts.push({ kind: "tool-result", callID, output: joinContentText(state.content), isError: false });
  } else if (state.status === "error") {
    const output = state.error !== null && state.error !== undefined
      ? scalar(state.error)
      : joinContentText(state.content);
    parts.push({ kind: "tool-result", callID, output, isError: true });
  }
}

function parseContentParts(content: unknown[]): ChroniclerPart[] {
  const parts: ChroniclerPart[] = [];
  for (const item of content) {
    const obj = asObject(item);
    if (!obj) {
      parts.push(unknownPart("untagged", item));
      continue;
    }
    const type = obj.type;
    if (type === "tool") {
      parseToolPart(obj, parts);
    } else if (type === "reasoning") {
      parts.push({ kind: "reasoning", text: stringOrNull(obj.text) ?? "" });
    } else if (type === "text") {
      parts.push({ kind: "text", text: stringOrNull(obj.text) ?? "" });
    } else {
      parts.push(unknownPart(type, item));
    }
  }
  return parts;
}

export function parseSessionMeta(row: SessionV2Row): SessionMeta {
  return {
    id: row.id,
    title: row.title ?? null,
    directory: row.directory ?? null,
    createdAt: toIso(row.time_created),
    updatedAt: toIso(row.time_updated),
    projectID: row.project_id ?? null,
    parentID: row.parent_id ?? null,
    version: row.version ?? null,
  };
}

function parseAssistant(data: Record<string, unknown> | null): ChroniclerPart[] {
  const content = Array.isArray(data?.content) ? data.content : [];
  const parts = parseContentParts(content);
  if (data && ("finish" in data || "cost" in data || "tokens" in data)) {
    parts.push({
      kind: "step-finish",
      meta: JSON.stringify({ finish: data.finish, cost: data.cost, tokens: data.tokens }),
    });
  }
  return parts;
}

function parseUser(data: Record<string, unknown> | null): ChroniclerPart[] {
  const parts: ChroniclerPart[] = [];
  const text = stringOrNull(data?.text);
  if (text !== null) parts.push({ kind: "text", text });
  const files = Array.isArray(data?.files) ? data.files : [];
  for (const file of files) parts.push(parseFileEntry(file));
  return parts;
}

function parseLifecycleMessage(row: SessionMessageRow): SessionMessage {
  const { malformed, data } = dataColumn(row.data);
  const time = messageTime(data, row);
  let parts: ChroniclerPart[];
  if (malformed) {
    parts = [unknownPart(row.type, row.data)];
  } else {
    switch (row.type) {
      case "system":
      case "synthetic":
        parts = [{ kind: "status", type: row.type, detail: stringOrNull(data?.text) }];
        break;
      case "idle":
        parts = [{ kind: "status", type: "idle", detail: stringOrNull(data?.outcome) }];
        break;
      case "model-switched":
        parts = [{ kind: "status", type: "model-switched", detail: `${scalar(data?.model)} (was ${scalar(data?.previous)})` }];
        break;
      case "agent-switched":
        parts = [{ kind: "status", type: "agent-switched", detail: `${scalar(data?.agent)} (was ${scalar(data?.previous)})` }];
        break;
      case "compaction": {
        const detail = data?.reason ?? data?.status ?? "compacted";
        parts = [{ kind: "status", type: "compaction", detail: scalar(detail) }];
        break;
      }
      default:
        parts = [unknownPart(row.type, data ?? row.data)];
    }
  }
  return { id: row.id, seq: row.seq, role: "system", time, parts };
}

export function parseSessionMessage(row: SessionMessageRow): SessionMessage {
  const role = roleFor(row.type);
  if (role === "system") return parseLifecycleMessage(row);
  const { malformed, data } = dataColumn(row.data);
  const parts = malformed
    ? [unknownPart(row.type, row.data)]
    : role === "assistant"
      ? parseAssistant(data)
      : parseUser(data);
  return { id: row.id, seq: row.seq, role, time: messageTime(data, row), parts };
}
