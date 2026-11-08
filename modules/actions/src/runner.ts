import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApiError, type Logger, type Store } from "@pi-spore/module-api";
import type {
  ActionRun,
  ActionRunStatus,
  ActionTrigger,
  ActionView,
  Workspace,
} from "@pi-spore/shared";

/** Retention deletes old logs (ADR 0121), so a vanished log file is a 404, not a server error. */
function logGone(error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === "ENOENT")
    throw new ApiError(404, "log_not_found", "The log of this run is gone");
  throw error;
}

export const MIGRATIONS = [
  `CREATE TABLE actions_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    action TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    signal TEXT,
    error TEXT,
    log_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
  )`,
  "CREATE INDEX actions_runs_by_workspace ON actions_runs (workspace_id, created_at)",
];

interface Row {
  id: string;
  workspace_id: string;
  action: string;
  trigger: ActionTrigger;
  status: ActionRunStatus;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  log_path: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

const toRun = (row: Row): ActionRun => ({
  id: row.id,
  workspaceId: row.workspace_id,
  action: row.action,
  trigger: row.trigger,
  status: row.status,
  ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
  ...(row.signal === null ? {} : { signal: row.signal }),
  ...(row.error === null ? {} : { error: row.error }),
  logPath: row.log_path,
  createdAt: row.created_at,
  ...(row.started_at === null ? {} : { startedAt: row.started_at }),
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
});

const ENDED = new Set<ActionRunStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
export const hasEnded = (run: ActionRun) => ENDED.has(run.status);

/** How long a cancelled run gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
const MAX_LOG_READ = 256 * 1024;

interface Live {
  workspace: Workspace;
  action: ActionView;
  env: Record<string, string>;
  child?: ChildProcess;
  cancelled: boolean;
  /** Called on every change: new output or a new status. */
  listeners: Set<() => void>;
  done: Promise<ActionRun>;
  finish: (run: ActionRun) => void;
}

// Runs live in their own process groups, so a cancel reaches every child they start. These groups do not die with
// the server by themselves; this kills them when the server process exits.
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const group of liveGroups) killGroup(group, "SIGTERM");
    });
  }
  liveGroups.add(pid);
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH: the group is already gone.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Index after the last complete UTF-8 character in `bytes`, so a read never ends inside a character. */
function completeEnd(bytes: Buffer): number {
  let i = bytes.length - 1;
  let continuation = 0;
  while (i >= 0 && ((bytes[i] as number) & 0xc0) === 0x80 && continuation < 3) {
    i--;
    continuation++;
  }
  if (i < 0) return bytes.length;
  const lead = bytes[i] as number;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return width > continuation + 1 ? i : bytes.length;
}

export interface RunnerOptions {
  store: Store;
  log: Logger;
  logsDir: string;
  now: () => number;
  newId: () => string;
  baseEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * Runs actions as child processes with an argv array (a shell only for `shell = true`), with output to a log file
 * per run (R12.3). Exclusive actions wait in line per folder (R12.2).
 */
export class ActionRunner {
  private readonly live = new Map<string, Live>();
  /** Per folder: the exclusive run that holds it, and the exclusive runs waiting for it, in order. */
  private readonly folders = new Map<string, { holder?: string; waiting: string[] }>();

  constructor(private readonly options: RunnerOptions) {
    // Nothing survives a restart: the exit hook killed what was running.
    const now = options.now();
    options.store.run(
      `UPDATE actions_runs SET status = 'interrupted', ended_at = ?,
         error = 'The pi-spore server stopped during this run'
       WHERE status IN ('queued', 'running')`,
      now,
    );
  }

  get(id: string): ActionRun {
    const row = this.options.store.get<Row>("SELECT * FROM actions_runs WHERE id = ?", id);
    if (!row) throw new ApiError(404, "run_not_found", `No action run ${id}`);
    return toRun(row);
  }

  list(workspaceId: string, limit = 50): ActionRun[] {
    return this.options.store
      .all<Row>(
        "SELECT * FROM actions_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
        workspaceId,
        limit,
      )
      .map(toRun);
  }

  /** Runs that have not ended, for a workspace. */
  unfinished(workspaceId: string): ActionRun[] {
    return this.options.store
      .all<Row>(
        "SELECT * FROM actions_runs WHERE workspace_id = ? AND status IN ('queued', 'running')",
        workspaceId,
      )
      .map(toRun);
  }

  /** Starts a run, or queues it behind an exclusive run in the same folder. Returns at once. */
  start(
    workspace: Workspace,
    action: ActionView,
    trigger: ActionTrigger,
    env: Record<string, string>,
  ): { run: ActionRun; done: Promise<ActionRun> } {
    const id = this.options.newId();
    const logPath = join(this.options.logsDir, workspace.id, `${id}.log`);
    let finish!: (run: ActionRun) => void;
    const done = new Promise<ActionRun>((resolve) => {
      finish = resolve;
    });
    const live: Live = {
      workspace,
      action,
      env,
      cancelled: false,
      listeners: new Set(),
      done,
      finish,
    };
    this.live.set(id, live);
    this.options.store.run(
      `INSERT INTO actions_runs (id, workspace_id, action, trigger, status, log_path, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      id,
      workspace.id,
      action.name,
      trigger,
      logPath,
      this.options.now(),
    );
    mkdirSync(dirname(logPath), { recursive: true });
    closeSync(openSync(logPath, "a"));

    if (action.exclusive) {
      const folder = this.folder(workspace.path);
      if (folder.holder) {
        folder.waiting.push(id);
        return { run: this.get(id), done };
      }
      folder.holder = id;
    }
    this.spawn(id, live);
    return { run: this.get(id), done };
  }

  /** Waits until the run has ended. */
  wait(id: string): Promise<ActionRun> {
    const live = this.live.get(id);
    return live ? live.done : Promise.resolve(this.get(id));
  }

  /** Stops a run: a queued one never starts, a running one gets SIGTERM, then SIGKILL. */
  cancel(id: string): ActionRun {
    const run = this.get(id);
    const live = this.live.get(id);
    if (hasEnded(run) || !live) return run;
    live.cancelled = true;
    if (run.status === "queued") {
      const folder = this.folders.get(live.workspace.path);
      if (folder) folder.waiting = folder.waiting.filter((waiting) => waiting !== id);
      this.end(id, live, { status: "cancelled" });
      return this.get(id);
    }
    const pid = live.child?.pid;
    if (pid !== undefined) {
      killGroup(pid, "SIGTERM");
      setTimeout(() => {
        if (this.live.has(id)) killGroup(pid, "SIGKILL");
      }, KILL_GRACE_MS).unref();
    }
    return this.get(id);
  }

  /**
   * Reads the log from byte `from`, or the tail when `from` is undefined. With `waitMs`, waits up to that long for
   * output past `from` or for the run to end, so a client can follow a run without polling.
   */
  async readLog(
    id: string,
    from: number | undefined,
    waitMs = 0,
  ): Promise<{ run: ActionRun; text: string; start: number; end: number; size: number }> {
    let run = this.get(id);
    const live = this.live.get(id);
    if (waitMs > 0 && live && from !== undefined) {
      const size = (await stat(run.logPath).catch(logGone)).size;
      if (size <= from) await this.change(live, waitMs);
      run = this.get(id);
    }
    const size = (await stat(run.logPath).catch(logGone)).size;
    const start = Math.min(size, from ?? Math.max(0, size - MAX_LOG_READ));
    const length = Math.min(MAX_LOG_READ, size - start);
    const bytes = Buffer.alloc(length);
    const file = await open(run.logPath, "r").catch(logGone);
    try {
      await file.read(bytes, 0, length, start);
    } finally {
      await file.close();
    }
    let skip = 0;
    // A tail may begin inside a character; skip to the next whole one.
    if (from === undefined)
      while (skip < length && ((bytes[skip] as number) & 0xc0) === 0x80) skip++;
    const end = completeEnd(bytes);
    return {
      run,
      text: bytes.subarray(skip, end).toString("utf8"),
      start: start + skip,
      end: start + end,
      size,
    };
  }

  private change(live: Live, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        live.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      live.listeners.add(done);
    });
  }

  private notify(live: Live): void {
    for (const listener of [...live.listeners]) listener();
  }

  private folder(path: string): { holder?: string; waiting: string[] } {
    let folder = this.folders.get(path);
    if (!folder) {
      folder = { waiting: [] };
      this.folders.set(path, folder);
    }
    return folder;
  }

  private spawn(id: string, live: Live): void {
    const { action, workspace } = live;
    const run = this.get(id);
    const [command, args] =
      typeof action.run === "string"
        ? ["/bin/sh", ["-c", action.run]]
        : [action.run[0] as string, action.run.slice(1)];
    const fd = openSync(run.logPath, "a");
    const write = (data: string | Buffer) => {
      if (typeof data === "string") writeSync(fd, data);
      else writeSync(fd, data);
      this.notify(live);
    };
    write(`$ ${typeof action.run === "string" ? action.run : action.run.join(" ")}\n`);
    this.options.store.run(
      "UPDATE actions_runs SET status = 'running', started_at = ? WHERE id = ?",
      this.options.now(),
      id,
    );

    let settled = false;
    const settle = (fields: Parameters<ActionRunner["end"]>[2]) => {
      if (settled) return;
      settled = true;
      if (live.child?.pid !== undefined) liveGroups.delete(live.child.pid);
      closeSync(fd);
      this.end(id, live, fields);
    };

    const child = spawn(command, args, {
      cwd: workspace.path,
      env: { ...this.options.baseEnv, ...live.env },
      // Its own process group, so cancel reaches the programs it starts.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.child = child;
    if (child.pid !== undefined) trackGroup(child.pid);
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("error", (error) => {
      write(`\npi-spore: cannot run ${command}: ${error.message}\n`);
      settle({ status: "failed", error: `Cannot run ${command}: ${error.message}` });
    });
    // "close" comes after the output streams end, so the log is complete.
    child.on("close", (code, signal) => {
      if (live.cancelled) {
        write("\npi-spore: cancelled\n");
        settle({ status: "cancelled", ...(signal ? { signal } : {}) });
      } else if (code === 0) settle({ status: "succeeded", exitCode: 0 });
      else
        settle({
          status: "failed",
          ...(code === null ? {} : { exitCode: code }),
          ...(signal ? { signal } : {}),
        });
    });
  }

  private end(
    id: string,
    live: Live,
    fields: { status: ActionRunStatus; exitCode?: number; signal?: string; error?: string },
  ): void {
    this.options.store.run(
      "UPDATE actions_runs SET status = ?, exit_code = ?, signal = ?, error = ?, ended_at = ? WHERE id = ?",
      fields.status,
      fields.exitCode ?? null,
      fields.signal ?? null,
      fields.error ?? null,
      this.options.now(),
      id,
    );
    this.live.delete(id);
    const run = this.get(id);
    live.finish(run);
    this.notify(live);

    const folder = this.folders.get(live.workspace.path);
    if (folder?.holder === id) {
      delete folder.holder;
      const next = folder.waiting.shift();
      const nextLive = next === undefined ? undefined : this.live.get(next);
      if (next !== undefined && nextLive) {
        folder.holder = next;
        this.spawn(next, nextLive);
      }
    }
    if (folder && !folder.holder && folder.waiting.length === 0)
      this.folders.delete(live.workspace.path);
  }
}
