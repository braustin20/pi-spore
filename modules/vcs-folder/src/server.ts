import { realpath, rm, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { ProjectsKey, type VcsProvider } from "@pi-spore/mod-projects/server";
import { ApiError, type Exec, type ServerModule } from "@pi-spore/module-api";

/** Plain folders: a scratch copy or the folder itself. The fallback provider for anything without version control. */
export function createFolderProvider(exec: Exec, worktrees: string): VcsProvider {
  return {
    kind: "folder",
    priority: 0,
    async detect(path) {
      return (await stat(path).catch(() => undefined))?.isDirectory() === true;
    },
    root: (path) => realpath(path),
    isolationModes: ["new", "in-place"],
    async createCopy(project, request) {
      if (request.isolation !== "new") {
        throw new ApiError(
          422,
          "not_supported",
          "Folder projects support only a scratch copy or in-place work",
        );
      }
      const result = await exec("cp", ["-a", "--reflink=auto", `${project.path}/.`, request.path], {
        cwd: project.path,
        timeoutMs: 600_000,
      });
      if (result.code !== 0) {
        await rm(request.path, { recursive: true, force: true });
        throw new ApiError(
          409,
          "copy_failed",
          `Copying ${project.path} failed: ${result.stderr.trim()}`,
        );
      }
      return { path: request.path };
    },
    async removeCopy(_project, location, { force }) {
      const rel = relative(worktrees, location.path);
      if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
        throw new ApiError(
          409,
          "outside_worktrees",
          `Refusing to remove ${location.path}: not inside ${worktrees}`,
        );
      }
      // A scratch copy has no history, so removing it always loses its contents.
      if (!force) {
        throw new ApiError(
          409,
          "uncommitted_work",
          `${location.path} is a scratch copy without version control. Archive with force to delete it.`,
        );
      }
      await rm(location.path, { recursive: true, force: true });
    },
  };
}

export const vcsFolderModule: ServerModule = {
  id: "vcs-folder",
  requires: ["projects"],
  core: true,
  setup(host) {
    host.use(ProjectsKey).registerVcs(createFolderProvider(host.exec, host.home.worktrees));
  },
};
