import { z } from "zod";
import { homedir } from "node:os";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const EnvSchema = z.object({
  OPENCODE_DB_PATH: z.string().min(1).default("~/.local/share/opencode/opencode.db"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(31701),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  CHRONICLER_DIR: z.string().min(1).default("."),
  CHRONICLER_LOG_PATH: z.string().min(1).default("./chronicler.log"),
});

export interface AppConfig {
  dbPath: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  chroniclerDir: string;
  logPath: string;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

export function loadEnv(raw: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid environment: " + JSON.stringify(parsed.error.flatten()));
  }
  const env = parsed.data;
  return {
    dbPath: expandHome(env.OPENCODE_DB_PATH),
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    chroniclerDir: expandHome(env.CHRONICLER_DIR),
    logPath: expandHome(env.CHRONICLER_LOG_PATH),
  };
}
