import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChroniclerDb } from "../db/opencode-db";
import type { Logger } from "../log";
import { readSessionHandler } from "./tools/read-session";
import { listSessionsHandler } from "./tools/list-sessions";

const SERVER_NAME = "opencode-chronicler";
const SERVER_VERSION = "0.1.0";

export function createMcpServer(db: ChroniclerDb, logger: Logger): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "read_session",
    {
      title: "Read session",
      description: "Render one opencode session as Markdown (metadata + messages in seq order).",
      inputSchema: {
        session_id: z.string().min(1).describe("opencode session id, e.g. ses_..."),
        include_tool_output: z
          .boolean()
          .optional()
          .describe("Include tool-result output in the markdown (default true)."),
        max_part_chars: z
          .number()
          .int()
          .min(100)
          .max(50000)
          .optional()
          .describe("Per-part truncation budget in characters (default 2000)."),
      },
    },
    readSessionHandler(db),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description: "List recent opencode sessions as a Markdown table.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive filter on title or directory."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum rows to return (default 20, cap 200)."),
      },
    },
    listSessionsHandler(db),
  );

  logger.debug("mcp server built", { tools: ["read_session", "list_sessions"] });
  return server;
}
