import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "@pi-spore/module-api";

/**
 * `<folder>/Library/Bee`, the copied script build graph that must go (ADR 0177), after the symlink guard.
 *
 * `cp -a` keeps a symlinked `Library` as the same link, and a removal follows links inside a path, so deleting
 * through it would cut into the folder the main checkout points at. Refuse instead (R2.6, R10.2).
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
