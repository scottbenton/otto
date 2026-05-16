import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_FILENAME = "otto.lock";

export class LockError extends Error {
  constructor(
    message: string,
    public readonly pid: number,
  ) {
    super(message);
    this.name = "LockError";
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readExistingPid(lockPath: string): Promise<number | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(lockPath, "utf8");
    const pid = Number(raw.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  const lockPath = join(stateDir, LOCK_FILENAME);

  const existingPid = await readExistingPid(lockPath);
  if (existingPid !== undefined && isProcessRunning(existingPid)) {
    throw new LockError(
      `Another Otto instance is already running (PID: ${String(existingPid)}). ` +
        `If that process is no longer running, delete ${lockPath} and retry.`,
      existingPid,
    );
  }

  await writeFile(lockPath, String(process.pid), "utf8");

  return async () => {
    await rm(lockPath, { force: true });
  };
}
