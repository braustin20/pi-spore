import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Token use of one model in one session file. */
export interface ModelUse {
  provider: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SessionUse {
  path: string;
  /** The pi-spore workspace the session belongs to. Missing for a plain Pi session (R18.3). */
  workspaceId?: string;
  /** The folder the session ran in, from its header. */
  cwd?: string;
  models: ModelUse[];
  skippedLines: number;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Sums `usage` of every assistant message in a Pi session file, on all branches: each one was a real request
 * (Pi docs: session-format.md). Lines that are not JSON are counted, not fatal: a crash can leave a partial line.
 * A forked session (a side chat, ADR 0030) starts with copies of its parent's entries, written before its header's
 * time; those requests were counted in the parent's file, so they are skipped here.
 */
export function sumSession(text: string): Omit<SessionUse, "path" | "workspaceId"> {
  const models = new Map<string, ModelUse>();
  let skippedLines = 0;
  let forkedAt: number | undefined;
  let cwd: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: {
      type?: unknown;
      message?: unknown;
      timestamp?: unknown;
      parentSession?: unknown;
      cwd?: unknown;
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      skippedLines++;
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      if (typeof entry.parentSession === "string") {
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
        if (!Number.isNaN(at)) forkedAt = at;
      }
      continue;
    }
    if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null)
      continue;
    if (forkedAt !== undefined && typeof entry.timestamp === "string") {
      const at = Date.parse(entry.timestamp);
      if (!Number.isNaN(at) && at < forkedAt) continue;
    }
    const message = entry.message as {
      role?: unknown;
      provider?: unknown;
      model?: unknown;
      usage?: {
        input?: unknown;
        output?: unknown;
        cacheRead?: unknown;
        cacheWrite?: unknown;
        cost?: { total?: unknown };
      };
    };
    if (
      message.role !== "assistant" ||
      typeof message.provider !== "string" ||
      typeof message.model !== "string"
    )
      continue;
    const key = `${message.provider}/${message.model}`;
    const use = models.get(key) ?? {
      provider: message.provider,
      model: message.model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    use.requests++;
    use.input += count(message.usage?.input);
    use.output += count(message.usage?.output);
    use.cacheRead += count(message.usage?.cacheRead);
    use.cacheWrite += count(message.usage?.cacheWrite);
    use.cost += count(message.usage?.cost?.total);
    models.set(key, use);
  }
  return { ...(cwd === undefined ? {} : { cwd }), models: [...models.values()], skippedLines };
}

/**
 * Reads session files from two folders laid out the same way, `<folder>/<name>/*.jsonl`: pi-spore's own, where the
 * name is a workspace id, and Pi's default one, where it is the encoded folder a plain `pi` ran in (R18.3). It keeps
 * each file's sums until its size or modification time changes, so a page load does not re-read every transcript.
 */
export class SessionIndex {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; use: SessionUse }>();

  constructor(
    private readonly sessionsDir: string,
    private readonly plainSessionsDir: string,
  ) {}

  async scan(): Promise<SessionUse[]> {
    const seen = new Set<string>();
    const result = [
      ...(await this.scanFolder(this.sessionsDir, true, seen)),
      ...(await this.scanFolder(this.plainSessionsDir, false, seen)),
    ];
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    return result;
  }

  private async scanFolder(root: string, named: boolean, seen: Set<string>): Promise<SessionUse[]> {
    const result: SessionUse[] = [];
    for (const folder of await listDir(root)) {
      const dir = join(root, folder);
      for (const name of await listDir(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile()) continue;
        const cached = this.cache.get(path);
        if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
          seen.add(path);
          result.push(cached.use);
          continue;
        }
        // Retention can delete the file between the stat and the read.
        const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (text === undefined) continue;
        seen.add(path);
        const use: SessionUse = {
          path,
          ...(named ? { workspaceId: folder } : {}),
          ...sumSession(text),
        };
        this.cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, use });
        result.push(use);
      }
    }
    return result;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}
