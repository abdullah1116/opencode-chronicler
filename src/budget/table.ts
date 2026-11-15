import { defer, firstValueFrom, from } from "rxjs";
import type { Observable } from "rxjs";
import type { Database } from "bun:sqlite";
import type { BoundedSessions, SessionSummary } from "../domain/types";
import { countSessions$, listSessionPage$, SESSION_PAGE_SIZE } from "../db/queries";
import type { SessionPageRow, SessionSortKey } from "../db/queries";
import { bodyBudgetChars, estimateTokens, MIN_BODY_CHARS } from "../limits";
import {
  renderSessionRow,
  SESSIONS_TABLE_FOOTER_RESERVE_CHARS,
  SESSIONS_TABLE_HEAD_CHARS,
} from "../render/sessions-table";

export interface BoundedSessionsParams {
  query?: string;
  tokenBudget: number;
}

export function loadBoundedSessions$(
  db: Database,
  params: BoundedSessionsParams,
): Observable<BoundedSessions> {
  return defer(() => from(buildBoundedSessions(db, params)));
}

function finalize(
  rows: SessionSummary[],
  totalRows: number,
  tokenBudget: number,
  spent: number,
): BoundedSessions {
  const estimatedTokens = estimateTokens(
    SESSIONS_TABLE_HEAD_CHARS + spent + SESSIONS_TABLE_FOOTER_RESERVE_CHARS,
  );
  return { rows, totalRows, tokenBudget, estimatedTokens };
}

async function buildBoundedSessions(
  db: Database,
  params: BoundedSessionsParams,
): Promise<BoundedSessions> {
  const totalRows: number = await firstValueFrom(countSessions$(db, { query: params.query }));
  const budgetChars = Math.max(
    MIN_BODY_CHARS,
    bodyBudgetChars(params.tokenBudget) -
      SESSIONS_TABLE_HEAD_CHARS -
      SESSIONS_TABLE_FOOTER_RESERVE_CHARS,
  );

  const rows: SessionSummary[] = [];
  let spent = 0;
  let cursor: SessionSortKey | null = null;

  while (rows.length < totalRows) {
    const page: SessionPageRow[] = await firstValueFrom(
      listSessionPage$(db, { query: params.query, before: cursor, limit: SESSION_PAGE_SIZE }),
    );
    if (page.length === 0) break;

    for (const entry of page) {
      const cost = renderSessionRow(entry.summary).length + 1;
      if (rows.length > 0 && spent + cost > budgetChars) {
        return finalize(rows, totalRows, params.tokenBudget, spent);
      }
      rows.push(entry.summary);
      spent += cost;
    }

    const last: SessionPageRow = page[page.length - 1]!;
    if (last.sortMs === null) break;
    cursor = { timeUpdated: last.sortMs, id: last.summary.id };
  }

  return finalize(rows, totalRows, params.tokenBudget, spent);
}
