import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { ProjectsKey, type VcsProvider } from "@pi-spore/mod-projects/server";
import { ApiError, type Exec, type ServerModule } from "@pi-spore/module-api";

/** Runs git without a shell and returns stdout; a non-zero exit becomes an ApiError with git's own message. */
async function git(
  exec: Exec,
  cwd: string,
  args: readonly string[],
  status: 409 | 422 = 422,
): Promise<string> {
  const result = await exec("git", args, { cwd, timeoutMs: 120_000 });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`;
    throw new ApiError(status, "git_failed", `git ${args.join(" ")}: ${message}`);
  }
  return result.stdout;
}

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

export function createGitProvider(exec: Exec, worktrees: string): VcsProvider {
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
        await git(
          exec,
          project.path,
          ["worktree", "add", "-b", request.line, request.path, base],
          409,
        );
        return { path: request.path, line: request.line, base };
      }
      await git(exec, project.path, ["worktree", "add", request.path, request.line], 409);
      return { path: request.path, line: request.line };
    },
    async removeCopy(project, location, { force }) {
      assertInside(worktrees, location.path);
      if (!force) {
        const status = await git(exec, location.path, ["status", "--porcelain"]);
        if (status.trim() !== "") {
          throw new ApiError(
            409,
            "uncommitted_work",
            `${location.path} has uncommitted or untracked files. Commit them, or archive with force to delete them.`,
          );
        }
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
