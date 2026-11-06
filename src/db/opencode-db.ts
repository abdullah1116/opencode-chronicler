// Read-only invariant: every handle opens with `{ readonly: true }`; this layer never writes.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Observable } from "rxjs";
import type { AppConfig } from "../config/env";
import type { SessionDoc, SessionSummary } from "../domain/types";
import { listSessions$, loadSessionDoc$ } from "./queries";
import type { ListSessionsParams } from "./queries";

export function openDatabase(dbPath: string): Database {
  if (!existsSync(dbPath)) {
    throw new Error(`opencode database not found: ${dbPath}`);
  }
  return new Database(dbPath, { readonly: true, create: false });
}

export interface ChroniclerDb {
  raw: Database;
  listSessions(params?: ListSessionsParams): Observable<SessionSummary[]>;
  loadSessionDoc(id: string): Observable<SessionDoc>;
}

export function createChroniclerDb(config: AppConfig): ChroniclerDb {
  const raw = openDatabase(config.dbPath);
  return {
    raw,
    listSessions: (params = {}) => listSessions$(raw, params),
    loadSessionDoc: (id) => loadSessionDoc$(raw, id),
  };
}
