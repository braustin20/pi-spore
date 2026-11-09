import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Whether a process exists. EPERM means it does, under another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock folder (ADR 0010). It must be per user and cleared at logout, so there is no fallback. */
export function lockDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime) throw new Error("XDG_RUNTIME_DIR is not set, so local targets cannot be locked");
  return join(runtime, "pi-spore");
}

const lockBase = (target: string): string => target.replace(/[^\w.-]+/g, "_");

/**
 * Slots on local targets, shared by every Pi process of the user through lock files: `<dir>/<target>.<n>.lock`,
 * one per slot up to the target's concurrency (ADR 0010). A lock whose process is gone is taken over. A session that
 * waits for a slot leaves `<dir>/<target>.wait.<pid>.lock` so others can see the queue (ADR 0141).
 */
export class LocalLocks {
  constructor(
    private readonly dir: string,
    private readonly pid: number = process.pid,
    private readonly isAlive: (pid: number) => boolean = processAlive,
  ) {}

  /** Takes a free slot and returns its path, or returns undefined when every slot is held by a live process. */
  async tryAcquire(
    target: string,
    concurrency: number,
    session: string,
  ): Promise<string | undefined> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const base = lockBase(target);
    for (let slot = 0; slot < concurrency; slot++) {
      const path = join(this.dir, `${base}.${slot}.lock`);
      if (await this.tryTake(path, session)) return path;
    }
    return undefined;
  }

  /**
   * Whether every slot is held by a live process other than this one, and how many other live processes wait. Wait
   * files of dead processes are removed.
   */
  async queue(target: string, concurrency: number): Promise<{ busy: boolean; waiting: number }> {
    const base = lockBase(target);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { busy: false, waiting: 0 };
      throw error;
    }
    let held = 0;
    for (let slot = 0; slot < concurrency; slot++) {
      if (!names.includes(`${base}.${slot}.lock`)) continue;
      const holder = await this.holder(join(this.dir, `${base}.${slot}.lock`));
      if (holder !== undefined && holder !== this.pid && this.isAlive(holder)) held++;
    }
    let waiting = 0;
    const waitFile = new RegExp(`^${base.replace(/[.]/g, "\\.")}\\.wait\\.(\\d+)\\.lock$`);
    for (const name of names) {
      const pid = Number(waitFile.exec(name)?.[1]);
      if (!Number.isInteger(pid)) continue;
      if (pid === this.pid) continue;
      if (this.isAlive(pid)) waiting++;
      else await rm(join(this.dir, name), { force: true });
    }
    return { busy: held === concurrency, waiting };
  }

  /** Marks this process as waiting for the target and returns the wait file's path. */
  async joinQueue(target: string, session: string): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${lockBase(target)}.wait.${this.pid}.lock`);
    await writeFile(
      path,
      JSON.stringify({ pid: this.pid, session, since: new Date().toISOString() }),
      { mode: 0o600 },
    );
    return path;
  }

  async leaveQueue(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async release(path: string): Promise<void> {
    const holder = await this.holder(path);
    if (holder === this.pid) await rm(path, { force: true });
  }

  private async tryTake(path: string, session: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: this.pid, session, since: new Date().toISOString() }),
        );
        await handle.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await this.holder(path);
      if (holder === this.pid) return true;
      if (holder !== undefined && this.isAlive(holder)) return false;
      // The holder is gone, or the file is unreadable junk: take it over once.
      await rm(path, { force: true });
    }
    return false;
  }

  private async holder(path: string): Promise<number | undefined> {
    try {
      const pid = (JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid;
      return typeof pid === "number" && Number.isInteger(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }
}
