import { defer, EMPTY, of } from "rxjs";
import type { Observable } from "rxjs";
import type { Database } from "bun:sqlite";
import type { SessionDoc, SessionSummary } from "../domain/types";
import { SessionMessageRowSchema, SessionV2RowSchema } from "./rows";
import type { SessionMessageRow, SessionV2Row } from "./rows";
import { parseSessionMessage, parseSessionMeta } from "./v2parse";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface ListSessionsParams {
  query?: string;
  limit?: number;
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function coerceMetaRow(raw: unknown): SessionV2Row | null {
  const parsed = SessionV2RowSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (typeof obj.id !== "string") return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    id: obj.id,
    title: str(obj.title),
    directory: str(obj.directory),
    project_id: str(obj.project_id),
    parent_id: str(obj.parent_id),
    version: str(obj.version),
    time_created: num(obj.time_created),
    time_updated: num(obj.time_updated),
  };
}

function coerceMessageRow(raw: unknown, index: number): SessionMessageRow {
  const parsed = SessionMessageRowSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const obj = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    id: typeof obj.id === "string" ? obj.id : `malformed-${index}`,
    session_id: typeof obj.session_id === "string" ? obj.session_id : "",
    type: typeof obj.type === "string" ? obj.type : null,
    seq: typeof obj.seq === "number" ? obj.seq : index,
    time_created: num(obj.time_created),
    time_updated: num(obj.time_updated),
    data: obj.data,
  };
}

function previewFrom(rawPreview: unknown): string | null {
  if (typeof rawPreview !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(rawPreview);
    if (parsed !== null && typeof parsed === "object") {
      const text = (parsed as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
    return null;
  } catch {
    return null;
  }
}

function firstUserPreviewRow(db: Database, sessionId: string): unknown {
  return db
    .query(
      "SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq ASC LIMIT 1",
    )
    .get(sessionId);
}

export function listSessions$(db: Database, params: ListSessionsParams = {}): Observable<SessionSummary[]> {
  return defer(() => {
    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (params.query !== undefined && params.query.length > 0) {
      conditions.push("(s.title LIKE ? ESCAPE '\\' OR s.directory LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(params.query)}%`;
      args.push(like, like);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    args.push(clampLimit(params.limit));

    const rows = db
      .query(
        `SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_updated AS time_updated,
                (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS message_count
         FROM session_v2 s
         ${where}
         ORDER BY s.time_updated DESC
         LIMIT ?`,
      )
      .all(...args) as Array<Record<string, unknown>>;

    const summaries: SessionSummary[] = rows.map((row) => {
      const id = typeof row.id === "string" ? row.id : "";
      const previewRow = firstUserPreviewRow(db, id);
      const preview =
        previewRow !== null && typeof previewRow === "object"
          ? previewFrom((previewRow as Record<string, unknown>).data)
          : null;
      const updatedAt =
        typeof row.time_updated === "number" ? new Date(row.time_updated).toISOString() : null;
      return {
        id,
        title: typeof row.title === "string" ? row.title : null,
        directory: typeof row.directory === "string" ? row.directory : null,
        updatedAt,
        messageCount: typeof row.message_count === "number" ? row.message_count : 0,
        preview,
      };
    });

    return of(summaries);
  });
}

export function loadSessionDoc$(db: Database, id: string): Observable<SessionDoc> {
  return defer(() => {
    const rawMeta = db.query("SELECT * FROM session_v2 WHERE id = ?").get(id);
    if (rawMeta === null || rawMeta === undefined) return EMPTY;
    const metaRow = coerceMetaRow(rawMeta);
    if (metaRow === null) return EMPTY;

    const rawMessages = db
      .query("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq ASC")
      .all(id) as unknown[];
    const messages = rawMessages.map((row, index) =>
      parseSessionMessage(coerceMessageRow(row, index)),
    );

    return of({ meta: parseSessionMeta(metaRow), messages });
  });
}
