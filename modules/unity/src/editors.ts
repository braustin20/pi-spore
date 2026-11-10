import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Projects } from "@pi-spore/mod-projects/server";
import type { Workspaces } from "@pi-spore/mod-workspaces/server";
import { ApiError, type Exec, type ExecResult, type Store } from "@pi-spore/module-api";
import {
  type EditorLease,
  type EditorSource,
  type OpenEditor,
  type ProjectEditors,
  parse,
  ValidationError,
} from "@pi-spore/shared";
import Type from "typebox";
import type { UnityEditors } from "./contract.js";

export const MIGRATIONS = [
  `CREATE TABLE unity_leases (
    project_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    workspace_id TEXT,
    owner TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    seen_at INTEGER
  )`,
];

interface LeaseRow {
  project_id: string;
  path: string;
  workspace_id: string | null;
  owner: EditorLease["owner"];
  opened_at: number;
  seen_at: number | null;
}

const toLease = (row: LeaseRow): EditorLease => ({
  projectId: row.project_id,
  path: row.path,
  ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
  owner: row.owner,
  openedAt: row.opened_at,
  ...(row.seen_at === null ? {} : { seenAt: row.seen_at }),
});

/** Error code of `unity close --json` for a project without the Pipeline package (spike Q17). */
const PIPELINE_MISSING = "PROJECTS_CLOSE_PIPELINE_MISSING";

const CloseOutput = Type.Object({
  errors: Type.Array(Type.Object({ code: Type.String() })),
});

/** True when the `--json` output of a failed close says exactly that the Pipeline package is missing. */
function pipelineMissing(stdout: string): boolean {
  try {
    return parse(CloseOutput, JSON.parse(stdout), "unity close output").errors.some(
      (error) => error.code === PIPELINE_MISSING,
    );
  } catch {
    // Not the JSON envelope: some other failure, which must not end the editor's process.
    return false;
  }
}

/** A lease whose editor was never seen is dropped after this long, for example when Unity failed to start. */
const STARTUP_GRACE_MS = 10 * 60_000;

/** The `unity` CLI: `command` and the arguments that come before the subcommand. */
export interface UnityCommand {
  command: string;
  args: readonly string[];
}

export interface ProcessInfo {
  pid: number;
  argv: string[];
}

/** Running processes, or undefined where they cannot be listed. */
export type ListProcesses = () => Promise<ProcessInfo[] | undefined>;

/** Processes with a `-projectpath` argument, from `/proc` (Linux). Undefined without `/proc`. */
export const listProcesses: ListProcesses = async () => {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return undefined;
  }
  const found = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry): Promise<ProcessInfo | undefined> => {
        // Processes end and belong to other users; an unreadable one is simply not a match.
        const text = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
        return /-projectpath\0/i.test(text)
          ? { pid: Number(entry), argv: text.split("\0").filter(Boolean) }
          : undefined;
      }),
  );
  return found.filter((process) => process !== undefined);
};

/** The folder a Unity process has open, from `-projectPath <folder>` (any case). */
export function projectPathOf(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((arg) => arg.toLowerCase() === "-projectpath");
  const path = index === -1 ? undefined : argv[index + 1];
  return path ? resolve(path) : undefined;
}

/**
 * `unity status --json`. Rows are under `data.instances` (CLI 1.0.0-beta.11) or `data.items` (later docs), with
 * `projectPath` or the older `project`. It lists only editors whose project has the Pipeline package.
 */
const StatusOutput = Type.Object({
  data: Type.Optional(
    Type.Object({
      instances: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
      items: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
    }),
  ),
});

interface StatusRow {
  path: string;
  pid?: number;
  state?: string;
}

export function parseStatus(stdout: string): StatusRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new ValidationError(`unity status did not print JSON: ${stdout.slice(0, 200)}`);
  }
  const output = parse(StatusOutput, raw, "unity status output");
  const rows = [...(output.data?.instances ?? []), ...(output.data?.items ?? [])];
  return rows.flatMap((row) => {
    const path = typeof row.projectPath === "string" ? row.projectPath : row.project;
    if (typeof path !== "string" || path === "") return [];
    return [
      {
        path: resolve(path),
        ...(typeof row.pid === "number" ? { pid: row.pid } : {}),
        ...(typeof row.state === "string" ? { state: row.state } : {}),
      },
    ];
  });
}

const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined;

export interface EditorsDeps {
  store: Store;
  exec: Exec;
  unity: UnityCommand;
  processes: ListProcesses;
  now: () => number;
  projects: Projects;
  workspaces: Workspaces;
}

export interface EditorsOptions {
  /** Ask `unity status` too. Without it only local signs count, and a lease is dropped only when the
   * process list ran and its editor was seen before. */
  status?: boolean;
}

export function createEditors(deps: EditorsDeps): UnityEditors & {
  scan(projectId: string, options?: EditorsOptions): Promise<ProjectEditors>;
} {
  const runUnity = async (
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<ExecResult> => {
    try {
      return await deps.exec(
        deps.unity.command,
        [...deps.unity.args, ...args, "--no-banner", "--non-interactive"],
        { cwd, timeoutMs },
      );
    } catch (error) {
      throw new ApiError(
        503,
        "unity_cli_failed",
        `Cannot run the unity CLI "${deps.unity.command}": ${(error as Error).message}`,
      );
    }
  };

  const output = (result: ExecResult) =>
    (result.stderr.trim() || result.stdout.trim()).slice(-2_000);

  const scan = async (projectId: string, options: EditorsOptions = {}): Promise<ProjectEditors> => {
    const project = await deps.projects.get(projectId);
    const targets = new Map<string, string | undefined>([[resolve(project.path), undefined]]);
    for (const workspace of deps.workspaces.list({ projectId })) {
      const path = resolve(workspace.path);
      if (workspace.state !== "archived" && !targets.has(path)) targets.set(path, workspace.id);
    }

    const warnings: string[] = [];
    let rows: StatusRow[] = [];
    if (options.status !== false) {
      try {
        // It exits non-zero when no editor is found; the JSON on stdout still says why.
        rows = parseStatus((await runUnity(["status", "--json"], project.path, 15_000)).stdout);
      } catch (error) {
        warnings.push(`unity status failed: ${(error as Error).message}`);
      }
    }
    const processes = await deps.processes();
    if (!processes) warnings.push("Cannot list processes here; lock files count as open editors.");

    const editors: OpenEditor[] = [];
    const staleLocks: string[] = [];
    for (const [path, workspaceId] of targets) {
      const row = rows.find((candidate) => candidate.path === path);
      const process = processes?.find((candidate) => projectPathOf(candidate.argv) === path);
      const seenBy: EditorSource[] = [];
      if (row) seenBy.push("status");
      if (process) seenBy.push("process");
      if (await exists(join(path, "Temp", "UnityLockfile"))) {
        // A lock file with no editor behind it is left over from a crash.
        if (row || process || !processes) seenBy.push("lockfile");
        else staleLocks.push(path);
      }
      if (seenBy.length === 0) continue;
      const pid = row?.pid ?? process?.pid;
      editors.push({
        path,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(pid === undefined ? {} : { pid }),
        ...(row?.state === undefined ? {} : { state: row.state }),
        seenBy,
      });
    }

    const row = deps.store.get<LeaseRow>(
      "SELECT * FROM unity_leases WHERE project_id = ?",
      projectId,
    );
    let lease = row && toLease(row);
    if (row && lease) {
      const now = deps.now();
      if (editors.some((editor) => editor.path === row.path)) {
        deps.store.run("UPDATE unity_leases SET seen_at = ? WHERE project_id = ?", now, projectId);
        lease = { ...lease, seenAt: now };
      } else if (
        (options.status !== false &&
          (row.seen_at !== null || now - row.opened_at > STARTUP_GRACE_MS)) ||
        (processes !== undefined && row.seen_at !== null)
      ) {
        // The editor was seen and is gone now, or it never came up: it was closed outside pi-spore.
        deps.store.run("DELETE FROM unity_leases WHERE project_id = ?", projectId);
        lease = undefined;
      } else {
        editors.push({
          path: row.path,
          ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
          state: "starting",
          seenBy: ["lease"],
        });
      }
    }
    return { editors, staleLocks, ...(lease ? { lease } : {}), warnings };
  };

  const describe = (editor: OpenEditor) =>
    `${editor.workspaceId ? "workspace" : "the main checkout"} ${editor.path}`;

  return {
    scan,
    editors: (projectId) => scan(projectId),

    async open(workspaceId, owner) {
      const workspace = deps.workspaces.get(workspaceId);
      if (workspace.state === "archived")
        throw new ApiError(409, "bad_state", "The workspace is archived");
      const project = await deps.projects.get(workspace.projectId);
      if (!project.traits.some((trait) => trait.id === "unity"))
        throw new ApiError(422, "not_unity", `${project.name} is not a Unity project`);

      const target = resolve(workspace.path);
      const state = await scan(project.id);
      const others = state.editors.filter((editor) => editor.path !== target);
      if (others.length > 0) {
        const held =
          state.lease?.owner === "agent" ? " An agent holds it; wait for it to finish." : "";
        throw new ApiError(
          409,
          "editor_open",
          `Unity has ${others.map(describe).join(" and ")} open. One editor per project: close it first.${held}`,
        );
      }
      const leaseRow = (seenAt: number | null): LeaseRow => ({
        project_id: project.id,
        path: target,
        workspace_id: workspace.path === project.path ? null : workspace.id,
        owner,
        opened_at: deps.now(),
        seen_at: seenAt,
      });
      const save = (row: LeaseRow) => {
        deps.store.run(
          `INSERT OR REPLACE INTO unity_leases (project_id, path, workspace_id, owner, opened_at, seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.project_id,
          row.path,
          row.workspace_id,
          row.owner,
          row.opened_at,
          row.seen_at,
        );
        return toLease(row);
      };

      if (state.editors.some((editor) => editor.path === target)) {
        // Already open here: keep the holder, or record the user as the holder of an editor opened outside pi-spore.
        return { lease: state.lease ?? save(leaseRow(deps.now())), alreadyOpen: true };
      }
      const result = await runUnity(["open", target], project.path, 60_000);
      if (result.code !== 0) {
        throw new ApiError(503, "unity_open_failed", `unity open failed: ${output(result)}`);
      }
      return { lease: save(leaseRow(null)), alreadyOpen: false };
    },

    async close(projectId, path) {
      const target = resolve(path);
      const state = await scan(projectId);
      if (!state.editors.some((editor) => editor.path === target)) {
        throw new ApiError(404, "editor_not_found", `No Unity editor has ${target} open`);
      }
      const project = await deps.projects.get(projectId);
      let result = await runUnity(["close", "--json", target], project.path, 90_000);
      // Q17, ADR 0156: without the Pipeline package the editor has no graceful channel. The caller already has the
      // user's yes, and a graceful close would not save either, so --force changes only how the process ends.
      if (result.code !== 0 && pipelineMissing(result.stdout)) {
        result = await runUnity(["close", "--json", target, "--force"], project.path, 90_000);
      }
      if (result.code !== 0) {
        throw new ApiError(
          409,
          "close_failed",
          `Unity did not close ${target}: ${output(result)}. Close it in Unity.`,
        );
      }
      deps.store.run(
        "DELETE FROM unity_leases WHERE project_id = ? AND path = ?",
        projectId,
        target,
      );
    },
  };
}
