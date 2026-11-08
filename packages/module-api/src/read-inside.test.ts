import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import { readFileInside } from "./read-inside.js";

let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pi-spore-read-"));
  root = join(base, "root");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const refused = async (promise: Promise<unknown>, status: number, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect({ status: (error as ApiError).status, code: (error as ApiError).code }).toEqual({
    status,
    code,
  });
};

describe("readFileInside", () => {
  it("reads a file inside a root and returns its real path", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const result = await readFileInside(join(root, "a.txt"), [root], 100);
    expect(result.bytes.toString()).toBe("hello");
    expect(result.real.endsWith(join("root", "a.txt"))).toBe(true);
  });

  it("skips roots that do not exist", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const result = await readFileInside(join(root, "a.txt"), [join(base, "none"), root], 100);
    expect(result.bytes.toString()).toBe("hello");
  });

  it("refuses a .. escape and an absolute path outside the roots", async () => {
    writeFileSync(join(base, "outside.txt"), "x");
    await refused(
      readFileInside(join(root, "..", "outside.txt"), [root], 100),
      403,
      "outside_root",
    );
    await refused(readFileInside(join(base, "outside.txt"), [root], 100), 403, "outside_root");
  });

  it("refuses a symlink inside the root that points outside", async () => {
    writeFileSync(join(base, "outside.txt"), "x");
    symlinkSync(join(base, "outside.txt"), join(root, "link.txt"));
    await refused(readFileInside(join(root, "link.txt"), [root], 100), 403, "outside_root");
  });

  it("refuses a directory", async () => {
    mkdirSync(join(root, "dir"));
    await refused(readFileInside(join(root, "dir"), [root], 100), 415, "not_a_file");
  });

  it("refuses a file larger than the limit", async () => {
    writeFileSync(join(root, "big.txt"), "123456");
    await refused(readFileInside(join(root, "big.txt"), [root], 5), 413, "file_too_large");
  });

  it("answers 404 for a missing file", async () => {
    await refused(readFileInside(join(root, "none.txt"), [root], 100), 404, "file_not_found");
  });

  it("refuses a NUL in the path", async () => {
    await refused(readFileInside(`${root}/a\0.txt`, [root], 100), 400, "bad_path");
  });

  it("refuses a file when accept throws, before it is opened", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    await refused(
      readFileInside(join(root, "a.txt"), [root], 100, () => {
        throw new ApiError(415, "not_accepted", "no");
      }),
      415,
      "not_accepted",
    );
  });
});
