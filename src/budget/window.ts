import { catchError, defer, firstValueFrom, from, throwError, EMPTY } from "rxjs";
import type { Observable } from "rxjs";
import type { Database } from "bun:sqlite";
import { EmptyError } from "rxjs";
import type { BoundedDoc, DocDirection, RenderOptions, SessionMessage } from "../domain/types";
import { loadMessagePage$, loadSessionMetaCount$, MESSAGE_PAGE_SIZE } from "../db/queries";
import { bodyBudgetChars } from "../limits";
import { renderMessage } from "../render/session-md";

export interface BoundedDocParams {
  direction: DocDirection;
  tokenBudget: number;
  renderOptions: RenderOptions;
}

export function loadBoundedDoc$(
  db: Database,
  id: string,
  params: BoundedDocParams,
): Observable<BoundedDoc> {
  return defer(() => from(buildBoundedDoc(db, id, params))).pipe(
    catchError((error: unknown) =>
      error instanceof EmptyError ? EMPTY : throwError(() => error),
    ),
  );
}

async function buildBoundedDoc(
  db: Database,
  id: string,
  params: BoundedDocParams,
): Promise<BoundedDoc> {
  const { meta, totalMessages } = await firstValueFrom(loadSessionMetaCount$(db, id));
  const budgetChars = bodyBudgetChars(params.tokenBudget);

  const picked: SessionMessage[] = [];
  let spent = 0;
  let cursor: number | null = null;
  let truncatedBoundary = false;

  scan: while (picked.length < totalMessages) {
    const page: SessionMessage[] = await firstValueFrom(
      loadMessagePage$(db, id, {
        direction: params.direction === "head" ? "forward" : "backward",
        cursor,
        limit: MESSAGE_PAGE_SIZE,
      }),
    );
    if (page.length === 0) break;

    const ordered: SessionMessage[] = params.direction === "head" ? page : [...page].reverse();
    cursor = ordered[ordered.length - 1]!.seq;

    for (const message of ordered) {
      const cost = renderMessage(message, params.renderOptions).length + 2;
      if (picked.length === 0 && cost > budgetChars) {
        picked.push(message);
        truncatedBoundary = true;
        break scan;
      }
      if (spent + cost > budgetChars) break scan;
      picked.push(message);
      spent += cost;
      if (picked.length >= totalMessages) break scan;
    }
  }

  const messages = params.direction === "head" ? picked : [...picked].reverse();
  return {
    meta,
    messages,
    totalMessages,
    direction: params.direction,
    tokenBudget: params.tokenBudget,
    truncatedBoundary,
  };
}
