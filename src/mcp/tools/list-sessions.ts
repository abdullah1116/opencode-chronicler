import { firstValueFrom, map } from "rxjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChroniclerDb } from "../../db/opencode-db";
import { clampTokenBudget, TOKEN_BUDGET_DEFAULTS } from "../../limits";
import { renderSessionsTable } from "../../render/sessions-table";

export interface ListSessionsInput {
  query?: string;
  session_directory?: string;
  token_budget?: number;
}

export function listSessionsHandler(db: ChroniclerDb) {
  return async (input: ListSessionsInput): Promise<CallToolResult> => {
    const tokenBudget = clampTokenBudget(input.token_budget, TOKEN_BUDGET_DEFAULTS.list);
    try {
      const text = await firstValueFrom(
        db.loadBoundedSessions({
          query: input.query,
          session_directory: input.session_directory,
          tokenBudget,
        }).pipe(
          map((page) =>
            renderSessionsTable(page.rows, {
              totalRows: page.totalRows,
              estimatedTokens: page.estimatedTokens,
              tokenBudget: page.tokenBudget,
            }),
          ),
        ),
      );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  };
}
