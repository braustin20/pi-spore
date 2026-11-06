import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the store lock, so a second server refuses to start. A lock left by a dead process is taken over.
 * Returns a function that releases it.
 */
export function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        throw new Error(`Another pi-spore server (pid ${pid}) holds ${path}`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the lock ${path}`);
}
