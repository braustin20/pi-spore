import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HomePaths } from "@pi-spore/module-api";

export interface ServerPaths extends HomePaths {
  data: string;
  database: string;
  lock: string;
  token: string;
}

/** `PI_SPORE_HOME` overrides `~/.pi-spore`, so tests and a second install never touch the real data. */
export function resolveHome(env: Readonly<Record<string, string | undefined>>): ServerPaths {
  const root = env.PI_SPORE_HOME ?? join(homedir(), ".pi-spore");
  const data = join(root, "data");
  return {
    root,
    data,
    database: join(data, "pi-spore.sqlite"),
    lock: join(data, "pi-spore.sqlite.lock"),
    token: join(root, "token"),
    worktrees: join(root, "worktrees"),
    artifacts: join(root, "artifacts"),
    logs: join(root, "logs"),
    sessions: join(root, "sessions"),
  };
}

export function ensureHome(paths: ServerPaths): void {
  for (const dir of [
    paths.root,
    paths.data,
    paths.worktrees,
    paths.artifacts,
    paths.logs,
    paths.sessions,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
