import type { ChangeOps, PublishOps, WorkspaceLocation } from "@pi-spore/mod-projects/server";
import { ApiError, type Exec } from "@pi-spore/module-api";
import {
  type ChangedFile,
  ChangeRecord,
  type ChangeScope,
  type ChangeStatus,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
  parse,
} from "@pi-spore/shared";

/** Flags for every diff: no color, no user diff drivers, renames found. Output then has one fixed format. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"] as const;

/** Untracked files are diffed one process each; this many run at once. */
const UNTRACKED_CONCURRENCY = 8;

type Run = (cwd: string, args: readonly string[], okCodes?: readonly number[]) => Promise<string>;

function runner(exec: Exec): Run {
  return async (cwd, args, okCodes = [0]) => {
    const result = await exec("git", args, {
      cwd,
      timeoutMs: 120_000,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    if (!okCodes.includes(result.code)) {
      const message = result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`;
      throw new ApiError(422, "git_failed", `git ${args.join(" ")}: ${message}`);
    }
    return result.stdout;
  };
}

/** A commit id, or undefined when the name is not one. `--end-of-options` keeps a name like `--foo` a name. */
async function resolveCommit(exec: Exec, cwd: string, name: string): Promise<string | undefined> {
  const result = await exec(
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`],
    { cwd, timeoutMs: 30_000 },
  );
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The tree with nothing in it, to diff against when there is no commit (the first commit, a new repo). */
async function emptyTree(run: Run, cwd: string): Promise<string> {
  return (await run(cwd, ["hash-object", "-t", "tree", "/dev/null"])).trim();
}

/** Splits `-z` output into its fields; the output ends with a NUL. */
function fields(output: string): string[] {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function statusOf(letter: string): ChangeStatus {
  switch (letter[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    // T (type change) and M read as modified.
    case "M":
    case "T":
      return "modified";
    default:
      throw new Error(`git diff --name-status gave an unknown status "${letter}"`);
  }
}

interface Counts {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** `--numstat -z`: `A\tD\tpath\0`, or `A\tD\t\0old\0new\0` for a rename. Binary files count `-`. */
function parseNumstat(output: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  const parts = fields(output);
  for (let i = 0; i < parts.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i] as string);
    if (!match) throw new Error(`git diff --numstat gave a line it cannot read: ${parts[i]}`);
    let path = match[3] as string;
    if (path === "") {
      i += 2;
      path = parts[i] as string;
      if (path === undefined) throw new Error("git diff --numstat ended inside a rename");
    }
    const binary = match[1] === "-";
    counts.set(path, {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return counts;
}

/** `--name-status -z`: `X\0path\0`, or `R<score>\0old\0new\0`. */
function parseNameStatus(
  output: string,
): { status: ChangeStatus; path: string; oldPath?: string }[] {
  const parts = fields(output);
  const entries: { status: ChangeStatus; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = statusOf(parts[i] as string);
    const path = parts[i + 1];
    if (path === undefined) throw new Error("git diff --name-status ended without a path");
    if (status === "renamed") {
      const to = parts[i + 2];
      if (to === undefined) throw new Error("git diff --name-status ended inside a rename");
      entries.push({ status, path: to, oldPath: path });
      i++;
    } else entries.push({ status, path });
  }
  return entries;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Reads the hunks of a one-file `git diff`. Lines before the first hunk are headers. Anything else unknown throws. */
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    if (text.startsWith("@@")) {
      const match = HUNK_HEADER.exec(text);
      if (!match) throw new Error(`git diff gave a hunk header it cannot read: ${text}`);
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = { oldStart: oldLine, newStart: newLine, section: match[5] ?? "", lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const marker = text[0];
    const body = text.slice(1);
    let line: DiffLine;
    if (marker === " ")
      line = { kind: "context", oldLine: oldLine++, newLine: newLine++, text: body };
    else if (marker === "+") line = { kind: "add", newLine: newLine++, text: body };
    else if (marker === "-") line = { kind: "del", oldLine: oldLine++, text: body };
    else if (marker === "\\") {
      const last = hunk.lines.at(-1);
      if (last) last.noNewline = true;
      continue;
    } else throw new Error(`git diff gave a line it cannot read: ${text.slice(0, 80)}`);
    hunk.lines.push(line);
  }
  return hunks;
}

/** Runs `work` over `items`, `limit` at a time, keeping the order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

export function createGitChanges(exec: Exec): ChangeOps {
  const run = runner(exec);

  /** The commit HEAD points at, or undefined in a repo with no commits yet. */
  const head = async (cwd: string) => resolveCommit(exec, cwd, "HEAD");

  const baseCommit = async (cwd: string, base: string): Promise<string> => {
    const commit = await resolveCommit(exec, cwd, base);
    if (!commit)
      throw new ApiError(409, "base_not_found", `The base "${base}" is not a commit here`);
    return commit;
  };

  const recordCommit = async (cwd: string, id: string): Promise<string> => {
    if (!/^[0-9a-f]{4,64}$/i.test(id)) {
      throw new ApiError(400, "bad_record", `"${id}" is not a commit id`);
    }
    const commit = await resolveCommit(exec, cwd, id);
    if (!commit) throw new ApiError(404, "record_not_found", `No commit ${id}`);
    return commit;
  };

  /** The `git diff` arguments that select a scope, before the flags and paths. */
  const scopeArgs = async (cwd: string, scope: ChangeScope): Promise<string[]> => {
    switch (scope.kind) {
      case "uncommitted":
        return ["diff", (await head(cwd)) ?? (await emptyTree(run, cwd))];
      case "staged":
        return ["diff", "--cached", (await head(cwd)) ?? (await emptyTree(run, cwd))];
      case "line": {
        const base = await baseCommit(cwd, scope.base);
        const tip = await head(cwd);
        if (!tip) return ["diff", base, base];
        const fork = (await run(cwd, ["merge-base", base, tip], [0, 1])).trim();
        if (!fork) {
          throw new ApiError(
            409,
            "no_common_base",
            `The branch shares no history with "${scope.base}"`,
          );
        }
        return ["diff", fork, tip];
      }
      case "record": {
        const commit = await recordCommit(cwd, scope.id);
        const parent = await resolveCommit(exec, cwd, `${commit}^`);
        return ["diff", parent ?? (await emptyTree(run, cwd)), commit];
      }
    }
  };

  const untracked = async (cwd: string, paths: readonly string[] = []): Promise<string[]> =>
    fields(
      await run(cwd, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        ...(paths.length ? ["--", ...paths] : []),
      ]),
    ).filter((path) => !path.endsWith("/"));

  /** A new file against nothing. `git diff --no-index` exits 1 when the sides differ. */
  const noIndex = (cwd: string, extra: readonly string[], path: string) =>
    run(cwd, ["diff", "--no-index", ...DIFF_FLAGS, ...extra, "--", "/dev/null", path], [0, 1]);

  return {
    scopes: ["uncommitted", "staged", "line", "record"],

    async defaultBase(project) {
      const cwd = project.path;
      const remoteHead = await exec(
        "git",
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        { cwd, timeoutMs: 30_000 },
      );
      const candidates: string[] = [];
      if (remoteHead.code === 0) {
        const remote = remoteHead.stdout.trim();
        candidates.push(remote.replace(/^origin\//, ""), remote);
      }
      candidates.push("main", "master");
      for (const candidate of candidates) {
        if (await resolveCommit(exec, cwd, candidate)) return candidate;
      }
      return undefined;
    },

    head: (location) => head(location.path),

    async records(location, base, limit) {
      const cwd = location.path;
      const tip = await head(cwd);
      if (!tip) return [];
      const range = base ? `${await baseCommit(cwd, base)}..${tip}` : tip;
      const output = await run(cwd, [
        "log",
        "--no-color",
        `--max-count=${limit}`,
        "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e",
        range,
      ]);
      return output
        .split("\x1e")
        .map((entry) => entry.replace(/^\n/, ""))
        .filter((entry) => entry !== "")
        .map((entry) => {
          const [id, shortId, author, at, ...subject] = entry.split("\x1f");
          return parse(
            ChangeRecord,
            { id, shortId, author, at: Number(at) * 1000, subject: subject.join("\x1f") },
            "git log record",
          );
        });
    },

    async files(location, scope, limit) {
      const cwd = location.path;
      const args = await scopeArgs(cwd, scope);
      const [names, numbers] = await Promise.all([
        run(cwd, [...args, ...DIFF_FLAGS, "--name-status", "-z"]),
        run(cwd, [...args, ...DIFF_FLAGS, "--numstat", "-z"]),
      ]);
      const counts = parseNumstat(numbers);
      const files: ChangedFile[] = parseNameStatus(names).map((entry) => {
        const count = counts.get(entry.path);
        if (!count) throw new Error(`git diff --numstat has no line for ${entry.path}`);
        return { ...entry, ...count };
      });
      if (scope.kind === "uncommitted") {
        const fresh = (await untracked(cwd)).slice(0, Math.max(0, limit + 1 - files.length));
        const added = await mapLimited(fresh, UNTRACKED_CONCURRENCY, async (path) => {
          const [count] = [...parseNumstat(await noIndex(cwd, ["--numstat", "-z"], path)).values()];
          return {
            path,
            status: "added" as const,
            ...(count ?? { additions: 0, deletions: 0, binary: false }),
          };
        });
        files.push(...added);
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      }
      return { files: files.slice(0, limit), truncated: files.length > limit };
    },

    async diff(location, scope, file, limits) {
      const result = (hunks: DiffHunk[], note?: FileDiff["note"]): FileDiff => ({
        file,
        hunks,
        ...(note ? { note } : {}),
      });
      if (file.binary) return result([], "binary");
      if (file.additions + file.deletions > limits.maxLines) return result([], "too_large");
      const cwd = location.path;
      const isNew =
        scope.kind === "uncommitted" &&
        file.status === "added" &&
        (await untracked(cwd, [file.path])).includes(file.path);
      const patch = isNew
        ? await noIndex(cwd, [], file.path)
        : await run(cwd, [
            ...(await scopeArgs(cwd, scope)),
            ...DIFF_FLAGS,
            "--",
            ...(file.oldPath ? [file.oldPath] : []),
            file.path,
          ]);
      if (Buffer.byteLength(patch) > limits.maxBytes) return result([], "too_large");
      if (/^Binary files .* differ$/m.test(patch) && !patch.includes("\n@@")) {
        return result([], "binary");
      }
      return result(parseHunks(patch));
    },
  };
}

/** Pushes a branch to its remote without force (R9.3): a rejected push is an error, never a rewrite. */
export function createGitPublish(exec: Exec): PublishOps {
  const run = runner(exec);
  return {
    async push(location: WorkspaceLocation, line: string) {
      const cwd = location.path;
      const configured = await exec("git", ["config", "--get", `branch.${line}.remote`], {
        cwd,
        timeoutMs: 30_000,
      });
      let remote = configured.code === 0 ? configured.stdout.trim() : "";
      if (!remote) {
        const remotes = (await run(cwd, ["remote"])).split("\n").filter(Boolean);
        if (remotes.includes("origin")) remote = "origin";
        else if (remotes.length === 1) remote = remotes[0] as string;
        else if (remotes.length === 0) {
          throw new ApiError(409, "no_remote", "The repository has no remote to push to");
        } else {
          throw new ApiError(
            409,
            "no_remote",
            `The repository has several remotes and none is "origin": ${remotes.join(", ")}`,
          );
        }
      }
      const result = await exec(
        "git",
        ["push", "--porcelain", "--set-upstream", remote, `refs/heads/${line}:refs/heads/${line}`],
        { cwd, timeoutMs: 300_000, env: { GIT_TERMINAL_PROMPT: "0" } },
      );
      if (result.code !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        throw new ApiError(409, "push_failed", `git push to ${remote} failed: ${message}`);
      }
      return { remote };
    },
  };
}
