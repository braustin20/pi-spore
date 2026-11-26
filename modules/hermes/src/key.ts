import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** A key file the connector refuses. The message names the path only, never the content. */
export class KeyFileError extends Error {
  override name = "KeyFileError";
}

/** `~/` is the user's home. A relative path is refused when the key is read. */
export const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(4, "0");

/**
 * Reads the Hermes key at use time (ADR 0202 decision 8), so a changed or removed file applies at once. The folder
 * must be `0700` or narrower and the file `0600` or narrower, as for any secret pi-spore keeps.
 */
export async function readKey(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new KeyFileError(`The Hermes key file ${path} is not an absolute path`);
  let folderMode: number;
  let fileMode: number;
  try {
    folderMode = (await stat(dirname(path))).mode;
    fileMode = (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new KeyFileError(`The Hermes key file ${path} does not exist`);
    throw new KeyFileError(
      `Cannot read the Hermes key file ${path}: ${(error as NodeJS.ErrnoException).code}`,
    );
  }
  if ((folderMode & 0o077) !== 0)
    throw new KeyFileError(
      `The folder of the Hermes key file ${path} has mode ${octal(folderMode)}; it must be 0700 or narrower`,
    );
  if ((fileMode & 0o177) !== 0)
    throw new KeyFileError(
      `The Hermes key file ${path} has mode ${octal(fileMode)}; it must be 0600 or narrower`,
    );
  const key = (await readFile(path, "utf8")).trim();
  if (key === "") throw new KeyFileError(`The Hermes key file ${path} is empty`);
  // A key goes into a header. Refusing other bytes here keeps the header error, which could quote it, from happening.
  if (!/^[\x21-\x7e]+$/.test(key))
    throw new KeyFileError(`The Hermes key file ${path} holds characters a key cannot have`);
  return key;
}
