import { loadEnv } from "./config/env";
import { createLogger } from "./log";
import { createChroniclerDb } from "./db/opencode-db";
import { createHttpApp } from "./mcp/http";

const config = loadEnv();
const log = createLogger(config.logLevel);

log.info("opencode-chronicler starting", {
  dbPath: config.dbPath,
  host: config.host,
  port: config.port,
  logLevel: config.logLevel,
});

const db = createChroniclerDb(config);
log.info("opened opencode database (readonly)", { dbPath: config.dbPath });

const app = createHttpApp(config, db, log);
log.info(`listening on http://${config.host}:${app.port}/mcp`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);
  await app.stop();
  db.raw.close();
  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
