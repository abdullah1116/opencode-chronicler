// Spawn failures are logged and swallowed: the plugin host must never crash.
import { dirname } from "node:path";

const HEALTH_URL = "http://127.0.0.1:31701/health";

let started = false;

async function healthOk(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function spawnChronicler(): void {
  const dir = process.env.CHRONICLER_DIR ?? ".";
  const logPath = process.env.CHRONICLER_LOG_PATH ?? "./chronicler.log";
  const cmd =
    `mkdir -p ${shellQuote(dirname(logPath))}; ` +
    `exec bun run start >> ${shellQuote(logPath)} 2>&1`;
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: dir,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  proc.unref();
}

export async function startKeeper(): Promise<void> {
  if (started) return;
  started = true;
  try {
    if (await healthOk()) {
      console.log("[chronicler-keeper] already healthy, skipping spawn");
      return;
    }
    spawnChronicler();
    console.log("[chronicler-keeper] spawned chronicler on 127.0.0.1:31701");
  } catch (err) {
    console.error("[chronicler-keeper] spawn failed:", err);
  }
}

const keeper = async (_input?: unknown, _options?: unknown) => {
  await startKeeper();
  return {};
};
(keeper as any).id = "chronicler-keeper";
(keeper as any).setup = async () => {
  await startKeeper();
};

void startKeeper();

export default keeper;
export { keeper as server };
