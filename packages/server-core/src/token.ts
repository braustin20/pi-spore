import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Reads the API token, creating it (mode 0600) on first start. */
export function ensureToken(path: string): string {
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token.length < 32)
      throw new Error(`The token in ${path} is too short; delete the file to make a new one`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}

export function tokensMatch(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
