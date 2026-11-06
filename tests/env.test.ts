import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { loadEnv, expandHome } from "../src/config/env";

describe("loadEnv", () => {
  test("applies defaults when raw env is empty", () => {
    const cfg = loadEnv({});
    expect(cfg.dbPath).toBe(expandHome("~/.local/share/opencode/opencode.db"));
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(31701);
    expect(cfg.logLevel).toBe("info");
  });

  test("coerces PORT string to number", () => {
    const cfg = loadEnv({ PORT: "3999" });
    expect(cfg.port).toBe(3999);
  });

  test("throws on invalid PORT with a message naming PORT", () => {
    expect(() => loadEnv({ PORT: "not-a-port" })).toThrow(/PORT/);
    expect(() => loadEnv({ PORT: "70000" })).toThrow(/PORT/);
  });

  test("expands leading ~/ to homedir", () => {
    expect(expandHome("~/x")).toBe(homedir() + "/x");
    const cfg = loadEnv({ OPENCODE_DB_PATH: "~/custom.db" });
    expect(cfg.dbPath).toBe(homedir() + "/custom.db");
  });

  test("defaults the chronicler dir and log path to portable relative paths", () => {
    const cfg = loadEnv({});
    expect(cfg.chroniclerDir).toBe(".");
    expect(cfg.logPath).toBe("./chronicler.log");
  });

  test("expands ~ in CHRONICLER_DIR and CHRONICLER_LOG_PATH", () => {
    const cfg = loadEnv({ CHRONICLER_DIR: "~/repo", CHRONICLER_LOG_PATH: "~/logs/c.log" });
    expect(cfg.chroniclerDir).toBe(homedir() + "/repo");
    expect(cfg.logPath).toBe(homedir() + "/logs/c.log");
  });

  test("default OPENCODE_DB_PATH expands to the real opencode.db absolute path", () => {
    const cfg = loadEnv({});
    expect(cfg.dbPath).toBe(homedir() + "/.local/share/opencode/opencode.db");
    expect(cfg.dbPath.startsWith("/")).toBe(true);
  });

  test("LOG_LEVEL rejects 'loud' and accepts 'debug'", () => {
    expect(() => loadEnv({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
    expect(loadEnv({ LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });
});
