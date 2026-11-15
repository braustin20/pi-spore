import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Actions, ProvidedAction } from "@pi-spore/mod-actions/server";
import type { Projects } from "@pi-spore/mod-projects/server";
import { ApiError } from "@pi-spore/module-api";
import type { createEditors } from "./editors.js";

/**
 * `<folder>/Library/Bee`, the copied script build graph that must go (ADR 0177), after the symlink guard.
 *
 * `cp -a` keeps a symlinked `Library` as the same link, and a removal follows links inside a path, so deleting
 * through it would cut into the folder the main checkout points at. Refuse instead (R2.6, R10.2). One guard, so the
 * copy hook and the repair action cannot drift apart.
 */
export async function libraryBee(folder: string): Promise<string> {
  const library = join(folder, "Library");
  if ((await lstat(library).catch(() => undefined))?.isSymbolicLink()) {
    throw new ApiError(
      409,
      "symlinked_library",
      `${library} is a symlink, so pi-spore will not remove Library/Bee from this copy. Replace the project's Library symlink with a real folder, then create the workspace again.`,
    );
  }
  return join(folder, "Library", "Bee");
}

export interface RepairDeps {
  actions: Actions;
  editors: ReturnType<typeof createEditors>;
  projects: Projects;
}

/**
 * `unity-repair-library`: deletes `<worktree>/Library/Bee` so Unity rebuilds its scripts (ADR 0177). Worktrees made
 * before the copy fix keep their broken DLLs until this runs; the stale-cache gate says so in its message.
 */
export function registerRepair(deps: RepairDeps): void {
  const provided: ProvidedAction = {
    name: "unity-repair-library",
    description:
      "Deletes Library/Bee in this worktree so Unity rebuilds its scripts (ADR 0177). Not for the main checkout.",
    trait: "unity",
    prepare: async ({ workspace, log }) => {
      const path = resolve(workspace.path);
      const project = await deps.projects.get(workspace.projectId);
      // The main checkout's Library is what every new worktree is copied from: dropping its Bee would make the next
      // copy rebuild too, and it is the user's own folder.
      if (workspace.isolation === "in-place" || path === resolve(project.path))
        throw new Error(
          `unity-repair-library does not run on the main checkout (${path}). Its Library is the source of every copy.`,
        );
      // Unity writes into its Library as it works. Never close an editor here: the user saves and quits by hand.
      if (
        (await deps.editors.scan(workspace.projectId)).editors.some(
          (editor) => editor.path === path,
        )
      )
        throw new Error(
          `Unity has ${path} open. Save and quit Unity on this folder, then run unity-repair-library again.`,
        );
      const bee = await libraryBee(path);
      // Only paths: an action log is shown to the pipeline and to agents.
      log(`Removing ${bee}. Unity rebuilds its scripts on the next open.\n`);
      return { argv: ["rm", "-rf", "--", bee] };
    },
  };
  deps.actions.provide(provided);
}
