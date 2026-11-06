import { glob, mkdir, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { ApiError, type Exec } from "@pi-spore/module-api";

/**
 * Copies the gitignored files a new copy needs (R2.6, ADR 0018) from the main copy, with a reflink where the
 * filesystem supports it. Patterns are relative to the project root. Existing targets are left alone. Only paths are
 * logged and returned; file contents are never read.
 */
export async function copyIgnoredFiles(
  exec: Exec,
  from: string,
  to: string,
  patterns: readonly string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("/") || normalize(pattern).split(sep).includes("..")) {
      throw new ApiError(
        422,
        "bad_copy_pattern",
        `Copy pattern "${pattern}" must stay inside the project`,
      );
    }
    for await (const match of glob(pattern, { cwd: from })) {
      const rel = relative(from, join(from, match));
      if (rel.startsWith("..")) continue;
      const target = join(to, rel);
      if (await stat(target).catch(() => undefined)) continue;
      await mkdir(dirname(target), { recursive: true });
      const result = await exec("cp", ["-a", "--reflink=auto", join(from, rel), target], {
        cwd: from,
        timeoutMs: 1_800_000,
      });
      if (result.code !== 0) {
        throw new ApiError(
          409,
          "copy_failed",
          `Copying ${rel} into the new copy failed: ${result.stderr.trim()}`,
        );
      }
      copied.push(rel);
    }
  }
  return copied.sort();
}
