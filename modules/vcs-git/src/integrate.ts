import type { IntegrateOps, WorkspaceLocation } from "@pi-spore/mod-projects/server";
import { ApiError, type Exec } from "@pi-spore/module-api";
import { git } from "./git.js";

/** Joins lines in a run's copy. A copy on any line but `run/...` is refused, so a base line never moves (R9.3). */
export function createGitIntegrate(exec: Exec): IntegrateOps {
  async function assertRunLine(location: WorkspaceLocation): Promise<void> {
    const branch = (await git(exec, location.path, ["branch", "--show-current"])).trim();
    if (!branch.startsWith("run/")) {
      throw new ApiError(
        409,
        "not_run_line",
        `Refusing to change ${location.path}: it is on ${branch || "no branch"}, not a run/ branch`,
      );
    }
  }

  async function mergeInProgress(location: WorkspaceLocation): Promise<boolean> {
    const result = await exec("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: location.path,
      timeoutMs: 30_000,
    });
    return result.code === 0;
  }

  return {
    async createLine(project, line, base) {
      await git(exec, project.path, ["branch", "--no-track", line, base], 409);
    },
    async merge(location, line) {
      await assertRunLine(location);
      const result = await exec("git", ["merge", "--no-ff", "--no-commit", line], {
        cwd: location.path,
        timeoutMs: 120_000,
      });
      if (result.code === 0) return { conflicts: [] };
      const conflicts = (await git(exec, location.path, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .filter(Boolean);
      if (conflicts.length === 0) {
        const message = result.stderr.trim() || result.stdout.trim() || "git merge failed";
        throw new ApiError(409, "git_failed", `git merge ${line}: ${message}`);
      }
      await git(exec, location.path, ["merge", "--abort"], 409);
      return { conflicts };
    },
    async commit(location, message) {
      await assertRunLine(location);
      await git(exec, location.path, ["commit", "--no-edit", "-m", message], 409);
      return (await git(exec, location.path, ["rev-parse", "HEAD"])).trim();
    },
    async abort(location) {
      await assertRunLine(location);
      if (await mergeInProgress(location))
        await git(exec, location.path, ["merge", "--abort"], 409);
    },
    async diff(location, line) {
      return git(exec, location.path, ["diff", "--no-color", "--no-ext-diff", `HEAD...${line}`]);
    },
  };
}
