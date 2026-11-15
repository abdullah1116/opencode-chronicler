// Read-only invariant: every handle opens with `{ readonly: true }`; this layer never writes.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Observable } from "rxjs";
import type { AppConfig } from "../config/env";
import type { BoundedDoc, BoundedSessions } from "../domain/types";
import { loadBoundedDoc$ } from "../budget/window";
import type { BoundedDocParams } from "../budget/window";
import { loadBoundedSessions$ } from "../budget/table";
import type { BoundedSessionsParams } from "../budget/table";

export function openDatabase(dbPath: string): Database {
  if (!existsSync(dbPath)) {
    throw new Error(`opencode database not found: ${dbPath}`);
  }
  return new Database(dbPath, { readonly: true, create: false });
}

export interface ChroniclerDb {
  raw: Database;
  loadBoundedDoc(id: string, params: BoundedDocParams): Observable<BoundedDoc>;
  loadBoundedSessions(params: BoundedSessionsParams): Observable<BoundedSessions>;
}

export function createChroniclerDb(config: AppConfig): ChroniclerDb {
  const raw = openDatabase(config.dbPath);
  return {
    raw,
    loadBoundedDoc: (id, params) => loadBoundedDoc$(raw, id, params),
    loadBoundedSessions: (params) => loadBoundedSessions$(raw, params),
  };
}
