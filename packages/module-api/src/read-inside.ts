import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import { ApiError } from "./errors.js";

const MIB = 1024 * 1024;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * Reads a regular file that, after resolving symlinks, is inside one of `roots`, so a path from an agent or a
 * request can never read outside the folders it may serve. `path` is absolute; the caller resolves relative paths.
 * Roots that do not exist are skipped. `accept` runs on the real path after the roots check and before the file is
 * opened; it throws to refuse the file.
 */
export async function readFileInside(
  path: string,
  roots: readonly string[],
  maxBytes: number,
  accept?: (real: string) => void,
): Promise<{ real: string; bytes: Buffer }> {
  if (path.includes("\0")) throw new ApiError(400, "bad_path", "The path has a NUL character");
  const notFound = () => new ApiError(404, "file_not_found", `No file at ${path}`);
  const real = await realpath(path).catch(() => {
    throw notFound();
  });
  const realRoots = (
    await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))
  ).filter((root): root is string => root !== undefined);
  if (!realRoots.some((root) => inside(real, root))) {
    throw new ApiError(403, "outside_root", `${path} is outside the folders that may be read`);
  }
  accept?.(real);
  const checked = await stat(real);
  // O_NOFOLLOW and the same inode as the checked path: a symlink swapped in after the check is not followed.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw notFound();
  });
  try {
    const opened = await handle.stat();
    if (opened.ino !== checked.ino || opened.dev !== checked.dev) throw notFound();
    if (!opened.isFile()) throw new ApiError(415, "not_a_file", `${path} is not a regular file`);
    if (opened.size > maxBytes) {
      throw new ApiError(
        413,
        "file_too_large",
        `The file is ${formatMib(opened.size)}; the limit is ${formatMib(maxBytes)}`,
      );
    }
    return { real, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}
