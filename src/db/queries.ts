import { defer, EMPTY, of } from "rxjs";
import type { Observable } from "rxjs";
import type { Database } from "bun:sqlite";
import type { SessionMessage, SessionMeta, SessionSummary } from "../domain/types";
import { SessionMessageRowSchema, SessionV2RowSchema } from "./rows";
import type { SessionMessageRow, SessionV2Row } from "./rows";
import { parseSessionMessage, parseSessionMeta } from "./v2parse";

export const MESSAGE_PAGE_SIZE = 50;
export const SESSION_PAGE_SIZE = 25;

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;

export interface SessionMetaCount {
  meta: SessionMeta;
  totalMessages: number;
}

export interface MessagePageParams {
  direction?: "forward" | "backward";
  cursor?: number | null;
  limit?: number;
}

export interface SessionSortKey {
  timeUpdated: number;
  id: string;
}

export interface SessionPageParams {
  query?: string;
  before?: SessionSortKey | null;
  limit?: number;
}

export interface SessionPageRow {
  summary: SessionSummary;
  sortMs: number | null;
}

function pageLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PAGE_LIMIT);
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => "\\" + ch);
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

export function loadSessionMetaCount$(db: Database, id: string): Observable<SessionMetaCount> {
  return defer(() => {
    const rawMeta = db.query("SELECT * FROM session_v2 WHERE id = ?").get(id);
    if (rawMeta === null || rawMeta === undefined) return EMPTY;
    const metaRow = coerceMetaRow(rawMeta);
    if (metaRow === null) return EMPTY;

    const counted = db
      .query("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?")
      .get(id) as { n?: number } | null;
    const totalMessages = typeof counted?.n === "number" ? counted.n : 0;
    return of({ meta: parseSessionMeta(metaRow), totalMessages });
  });
}

export function loadMessagePage$(
  db: Database,
  id: string,
  params: MessagePageParams = {},
): Observable<SessionMessage[]> {
  return defer(() => {
    const limit = pageLimit(params.limit);
    const cursor = typeof params.cursor === "number" ? params.cursor : null;

    const toDomain = (rows: unknown[]): SessionMessage[] =>
      rows.map((row, index) => parseSessionMessage(coerceMessageRow(row, index)));

    if (params.direction === "backward") {
      const rows = (
        cursor === null
          ? db
              .query(
                "SELECT * FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
              )
              .all(id, limit)
          : db
              .query(
                "SELECT * FROM session_message WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
              )
              .all(id, cursor, limit)
      ) as unknown[];
      return of(toDomain(rows.reverse()));
    }

    const rows = (
      cursor === null
        ? db
            .query("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq ASC LIMIT ?")
            .all(id, limit)
        : db
            .query(
              "SELECT * FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
            )
            .all(id, cursor, limit)
    ) as unknown[];
    return of(toDomain(rows));
  });
}

function listConditions(params: SessionPageParams): { clause: string; args: Array<string | number> } {
  const conditions: string[] = [];
  const args: Array<string | number> = [];

  if (params.query !== undefined && params.query.length > 0) {
    conditions.push("(s.title LIKE ? ESCAPE '\\' OR s.directory LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(params.query)}%`;
    args.push(like, like);
  }

  if (params.before !== undefined && params.before !== null) {
    conditions.push("(s.time_updated < ? OR (s.time_updated = ? AND s.id < ?))");
    args.push(params.before.timeUpdated, params.before.timeUpdated, params.before.id);
  }

  return { clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", args };
}

function toSessionPageRow(db: Database, row: Record<string, unknown>): SessionPageRow {
  const id = typeof row.id === "string" ? row.id : "";
  const previewRow = firstUserPreviewRow(db, id);
  const preview =
    previewRow !== null && typeof previewRow === "object"
      ? previewFrom((previewRow as Record<string, unknown>).data)
      : null;
  const sortMs = typeof row.time_updated === "number" ? row.time_updated : null;
  return {
    summary: {
      id,
      title: typeof row.title === "string" ? row.title : null,
      directory: typeof row.directory === "string" ? row.directory : null,
      updatedAt: sortMs === null ? null : new Date(sortMs).toISOString(),
      messageCount: typeof row.message_count === "number" ? row.message_count : 0,
      preview,
    },
    sortMs,
  };
}

export function listSessionPage$(
  db: Database,
  params: SessionPageParams = {},
): Observable<SessionPageRow[]> {
  return defer(() => {
    const { clause, args } = listConditions(params);
    const rows = db
      .query(
        `SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_updated AS time_updated,
                (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS message_count
         FROM session_v2 s
         ${clause}
         ORDER BY s.time_updated DESC, s.id DESC
         LIMIT ?`,
      )
      .all(...args, pageLimit(params.limit)) as Array<Record<string, unknown>>;
    return of(rows.map((row) => toSessionPageRow(db, row)));
  });
}

export function countSessions$(db: Database, params: { query?: string } = {}): Observable<number> {
  return defer(() => {
    const { clause, args } = listConditions({ query: params.query });
    const row = db
      .query(`SELECT COUNT(*) AS n FROM session_v2 s ${clause}`)
      .get(...args) as { n?: number } | null;
    return of(typeof row?.n === "number" ? row.n : 0);
  });
}
