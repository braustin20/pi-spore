import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const isInside = (root: string, path: string): boolean => {
  const rest = relative(root, path);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

/**
 * Deletes `target` (a file, a folder tree, or a symlink) only when it lies strictly inside `root`, so a wrong path
 * in a row can never delete outside the folder its data belongs to. A symlink is removed itself; its destination
 * stays. A symlinked folder on the way to `target` that leads out of `root` is refused too. Returns whether
 * something was there.
 */
export async function removeInside(root: string, target: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const refuse = () =>
    new Error(`Refusing to delete ${resolvedTarget}: it is not inside ${resolvedRoot}`);
  if (!isInside(resolvedRoot, resolvedTarget)) throw refuse();
  const realRoot = await realpath(resolvedRoot);
  const realParent = await realpath(dirname(resolvedTarget)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (realParent === undefined) return false;
  if (realParent !== realRoot && !isInside(realRoot, realParent)) throw refuse();
  const existed = await lstat(resolvedTarget).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  await rm(resolvedTarget, { recursive: true, force: true });
  return existed;
}
