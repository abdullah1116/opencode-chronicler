import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChroniclerDb } from "../db/opencode-db";
import type { Logger } from "../log";
import { TOKEN_BUDGET_DEFAULTS, TOKEN_BUDGET_MAX, TOKEN_BUDGET_MIN } from "../limits";
import { readSessionHandler } from "./tools/read-session";
import { tailSessionHandler } from "./tools/tail-session";
import { listSessionsHandler } from "./tools/list-sessions";

const SERVER_NAME = "opencode-chronicler";
const SERVER_VERSION = "0.2.0";

function tokenBudgetField(fallback: number) {
  return z
    .number()
    .int()
    .min(TOKEN_BUDGET_MIN)
    .max(TOKEN_BUDGET_MAX)
    .optional()
    .describe(
      `Approximate token budget for the returned Markdown (default ${fallback}, range ${TOKEN_BUDGET_MIN}-${TOKEN_BUDGET_MAX}). Content past the budget is omitted with a notice.`,
    );
}

export function createMcpServer(db: ChroniclerDb, logger: Logger): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "read_session",
    {
      title: "Read session",
      description:
        "Render an opencode session as Markdown from the beginning, within an approximate token budget (metadata + messages in seq order). Later messages are omitted with a notice when the budget is reached.",
      inputSchema: {
        session_id: z.string().min(1).describe("opencode session id, e.g. ses_..."),
        include_tool_output: z
          .boolean()
          .optional()
          .describe("Include tool-result output in the markdown (default true)."),
        token_budget: tokenBudgetField(TOKEN_BUDGET_DEFAULTS.read),
      },
    },
    readSessionHandler(db),
  );

  server.registerTool(
    "tail_session",
    {
      title: "Tail session",
      description:
        "Render the newest messages of an opencode session as Markdown within an approximate token budget, walking backwards in seq order. Earlier messages are omitted with a notice when the budget is reached.",
      inputSchema: {
        session_id: z.string().min(1).describe("opencode session id, e.g. ses_..."),
        include_tool_output: z
          .boolean()
          .optional()
          .describe("Include tool-result output in the markdown (default true)."),
        token_budget: tokenBudgetField(TOKEN_BUDGET_DEFAULTS.tail),
      },
    },
    tailSessionHandler(db),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description:
        "List recent opencode sessions as a Markdown table, newest first, within an approximate token budget.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive filter on title or directory."),
        token_budget: tokenBudgetField(TOKEN_BUDGET_DEFAULTS.list),
      },
    },
    listSessionsHandler(db),
  );

  logger.debug("mcp server built", {
    tools: ["read_session", "tail_session", "list_sessions"],
  });
  return server;
}
