import { ApiError, type Exec } from "@pi-spore/module-api";

/** Runs git without a shell and returns stdout; a non-zero exit becomes an ApiError with git's own message. */
export async function git(
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
