// `/mcp` is stateless: each request needs a fresh McpServer and transport — the transport is single-use, never cache it.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppConfig } from "../config/env";
import type { ChroniclerDb } from "../db/opencode-db";
import type { Logger } from "../log";
import { createMcpServer } from "./server-factory";

const JSON_HEADERS = { "content-type": "application/json" } as const;

export interface HttpApp {
  port: number;
  stop(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function createHttpApp(config: AppConfig, db: ChroniclerDb, logger: Logger): HttpApp {
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return json({ status: "ok", service: "opencode-chronicler" });
      }

      if (url.pathname === "/mcp") {
        const mcpServer = createMcpServer(db, logger);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        transport.onerror = (error) => logger.error("mcp transport error", error.message);
        try {
          await mcpServer.connect(transport);
          return await transport.handleRequest(req);
        } catch (error) {
          logger.error("mcp request failed", error instanceof Error ? error.message : String(error));
          return json(
            { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
            500,
          );
        }
      }

      return json({ error: "not found" }, 404);
    },
  });

  return {
    port: server.port ?? config.port,
    stop: () => server.stop(true),
  };
}
