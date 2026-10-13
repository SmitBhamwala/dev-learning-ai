import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Atomic file replacement: write a temp file, fsync, then rename over the target. */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await renameWithRetry(tmp, path);
}

/** Windows can briefly hold files open (antivirus, indexers); retry EPERM/EBUSY a few times. */
export async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, 20 * 2 ** i));
    }
  }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Advisory lock with stale-lock recovery. Serialises writers across the CLI,
 * the dashboard and hook invocations running at the same time.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = 10_000,
  staleMs = 30_000,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock ${lockPath}`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function writeFileIfAbsent(path: string, data: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, data, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
