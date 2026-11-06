import { firstValueFrom, map } from "rxjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChroniclerDb } from "../../db/opencode-db";
import { renderSessionsTable } from "../../render/sessions-table";

export interface ListSessionsInput {
  query?: string;
  limit?: number;
}

export function listSessionsHandler(db: ChroniclerDb) {
  return async (input: ListSessionsInput): Promise<CallToolResult> => {
    try {
      const text = await firstValueFrom(
        db
          .listSessions({ query: input.query, limit: input.limit })
          .pipe(map((summaries) => renderSessionsTable(summaries))),
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
