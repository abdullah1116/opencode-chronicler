import { EmptyError, firstValueFrom, map } from "rxjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChroniclerDb } from "../../db/opencode-db";
import { clampTokenBudget, deriveRenderOptions, TOKEN_BUDGET_DEFAULTS } from "../../limits";
import { renderBoundedDoc } from "../../render/session-md";

export interface ReadSessionInput {
  session_id: string;
  include_tool_output?: boolean;
  token_budget?: number;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function readSessionHandler(db: ChroniclerDb) {
  return async (input: ReadSessionInput): Promise<CallToolResult> => {
    const tokenBudget = clampTokenBudget(input.token_budget, TOKEN_BUDGET_DEFAULTS.read);
    const renderOptions = deriveRenderOptions(tokenBudget, input.include_tool_output ?? true);
    try {
      const text = await firstValueFrom(
        db
          .loadBoundedDoc(input.session_id, { direction: "head", tokenBudget, renderOptions })
          .pipe(map((doc) => renderBoundedDoc(doc, renderOptions))),
      );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      if (error instanceof EmptyError) {
        return errorResult(`Session not found: ${input.session_id}`);
      }
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  };
}
