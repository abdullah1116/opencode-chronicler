import type { LogLevel } from "./config/env";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

function serialize(extra: unknown): string {
  if (extra === undefined) return "";
  if (typeof extra === "string") return " " + extra;
  try {
    return " " + JSON.stringify(extra);
  } catch {
    return " [unserializable extra]";
  }
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, extra?: unknown): void => {
    if (ORDER[lvl] < threshold) return;
    console.error(`[${lvl.toUpperCase()}] ${msg}${serialize(extra)}`);
  };
  return {
    debug: (msg, extra) => emit("debug", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    error: (msg, extra) => emit("error", msg, extra),
  };
}
