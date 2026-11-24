import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { ProjectsKey, type VcsProvider } from "@pi-spore/mod-projects/server";
import { ApiError, type Exec, type ServerModule } from "@pi-spore/module-api";
import { createGitChanges, createGitPublish } from "./changes.js";
import { git } from "./git.js";
import { createGitIntegrate } from "./integrate.js";

/** Copies pi-spore removes must sit inside its worktrees folder. This guards against deleting anything else. */
function assertInside(parent: string, path: string): void {
  const rel = relative(parent, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
    throw new ApiError(
      409,
      "outside_worktrees",
      `Refusing to remove ${path}: it is not inside ${parent}`,
    );
  }
}

/**
 * Fetches `remote` and returns why it did not, or undefined. Git also updates the destinations of `remote.<name>.fetch`
 * for a named remote, even when a refspec is given. So a setting that writes outside `refs/remotes/` (for example
 * `+refs/heads/main:refs/heads/main`) could move or overwrite a local branch; such a remote is not fetched.
 */
async function fetchRemote(exec: Exec, cwd: string, remote: string): Promise<string | undefined> {
  const specs = await exec("git", ["config", "--get-all", `remote.${remote}.fetch`], {
    cwd,
    timeoutMs: 10_000,
  });
  const unsafe = specs.stdout
    .split("\n")
    .map((spec) => spec.trim().replace(/^\+/, "").split(":")[1])
    .find((destination) => destination && !destination.startsWith("refs/remotes/"));
  if (unsafe !== undefined) {
    return `its fetch setting writes to ${unsafe}, outside refs/remotes/`;
  }
  return exec("git", ["fetch", "--no-tags", remote], {
    cwd,
    timeoutMs: 60_000,
    env: { GIT_TERMINAL_PROMPT: "0" },
  }).then(
    (result) =>
      result.code === 0
        ? undefined
        : result.stderr.trim() || result.stdout.trim() || "fetch failed",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

/**
 * Where a new branch off `base` starts. When `base` tracks a remote branch, fetch (which moves only remote-tracking
 * refs) and start from the upstream commit if the local base is behind it. The local base is never moved. A commit id
 * is passed, not the upstream name, so git does not make the new branch track it.
 */
async function startPoint(
  exec: Exec,
  cwd: string,
  base: string,
): Promise<{ start: string; warnings: string[] }> {
  const warnings: string[] = [];
  const remoteResult = await exec("git", ["config", "--get", `branch.${base}.remote`], {
    cwd,
    timeoutMs: 10_000,
  });
  const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : "";
  if (remote === "") return { start: base, warnings };

  // A local upstream (remote ".") needs no fetch, but it can still be ahead of the base.
  if (remote !== ".") {
    const failure = await fetchRemote(exec, cwd, remote);
    if (failure !== undefined) {
      warnings.push(
        `Could not fetch ${remote}: ${failure}. The workspace starts from the local refs.`,
      );
    }
  }

  const upstream = await exec(
    "git",
    ["rev-parse", "--verify", "--quiet", `${base}@{upstream}^{commit}`],
    { cwd, timeoutMs: 10_000 },
  );
  if (upstream.code !== 0) return { start: base, warnings };
  const tip = upstream.stdout.trim();
  const behind = await exec("git", ["merge-base", "--is-ancestor", base, tip], {
    cwd,
    timeoutMs: 10_000,
  });
  return { start: behind.code === 0 ? tip : base, warnings };
}

export function createGitProvider(exec: Exec, worktrees: string): VcsProvider {
  /** Why `git worktree remove` refuses without force: `status --porcelain` covers the index, the worktree, and
   * untracked files, which is the whole state the removal looks at. */
  const lostWorkMessage = async (path: string): Promise<string | undefined> => {
    const status = await git(exec, path, ["status", "--porcelain"]);
    return status.trim() === ""
      ? undefined
      : `${path} has uncommitted or untracked files. Commit them, or archive with force to delete them.`;
  };
  return {
    kind: "git",
    priority: 10,
    async detect(path) {
      const result = await exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: path,
        timeoutMs: 10_000,
      });
      return result.code === 0;
    },
    async root(path) {
      return realpath((await git(exec, path, ["rev-parse", "--show-toplevel"])).trim());
    },
    isolationModes: ["new", "existing", "in-place"],
    async createCopy(project, request) {
      if (request.isolation === "new") {
        // Without a base, git starts the branch from the main checkout's HEAD, so that is the base to record.
        const base =
          request.base ??
          ((await git(exec, project.path, ["branch", "--show-current"])).trim() ||
            (await git(exec, project.path, ["rev-parse", "HEAD"])).trim());
        const { start, warnings } = await startPoint(exec, project.path, base);
        await git(
          exec,
          project.path,
          ["worktree", "add", "-b", request.line, request.path, start],
          409,
        );
        return { path: request.path, line: request.line, base, warnings };
      }
      await git(exec, project.path, ["worktree", "add", request.path, request.line], 409);
      return { path: request.path, line: request.line };
    },
    async lostWork(_project, location) {
      return lostWorkMessage(location.path);
    },
    async removeCopy(project, location, { force }) {
      assertInside(worktrees, location.path);
      if (!force) {
        const reason = await lostWorkMessage(location.path);
        if (reason) throw new ApiError(409, "uncommitted_work", reason);
      }
      // The branch stays, so committed work is never lost.
      await git(
        exec,
        project.path,
        ["worktree", "remove", ...(force ? ["--force"] : []), location.path],
        409,
      );
    },
    lines: {
      async list(project) {
        const refs = await git(exec, project.path, [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
        ]);
        const current = (await git(exec, project.path, ["branch", "--show-current"])).trim();
        return {
          lines: refs.split("\n").filter(Boolean).sort(),
          ...(current ? { current } : {}),
        };
      },
    },
    changes: createGitChanges(exec),
    publish: createGitPublish(exec),
    integrate: createGitIntegrate(exec),
  };
}

export const vcsGitModule: ServerModule = {
  id: "vcs-git",
  requires: ["projects"],
  core: true,
  setup(host) {
    host.use(ProjectsKey).registerVcs(createGitProvider(host.exec, host.home.worktrees));
  },
};
