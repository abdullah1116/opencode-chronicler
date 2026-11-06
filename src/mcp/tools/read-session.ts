import { EmptyError, firstValueFrom, map } from "rxjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChroniclerDb } from "../../db/opencode-db";
import { DEFAULT_RENDER_OPTIONS } from "../../domain/types";
import { renderSession } from "../../render/session-md";

export interface ReadSessionInput {
  session_id: string;
  include_tool_output?: boolean;
  max_part_chars?: number;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function readSessionHandler(db: ChroniclerDb) {
  return async (input: ReadSessionInput): Promise<CallToolResult> => {
    const options = {
      includeToolOutput: input.include_tool_output ?? DEFAULT_RENDER_OPTIONS.includeToolOutput,
      maxPartChars: input.max_part_chars ?? DEFAULT_RENDER_OPTIONS.maxPartChars,
    };
    try {
      const text = await firstValueFrom(
        db.loadSessionDoc(input.session_id).pipe(map((doc) => renderSession(doc, options))),
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
