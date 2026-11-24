import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ChroniclerDb } from "../db/opencode-db";
import type { Logger } from "../log";
import { createMcpServer } from "./server-factory";

export async function startStdio(db: ChroniclerDb, log: Logger): Promise<void> {
  const server = createMcpServer(db, log);
  const transport = new StdioServerTransport();
  transport.onerror = (error) => log.error("mcp transport error", error.message);
  await server.connect(transport);
}
