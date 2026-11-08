import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeInside } from "./remove-inside.js";

let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pi-spore-remove-"));
  root = join(base, "root");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("removeInside", () => {
  it("removes a folder tree inside the root and says it was there", async () => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "f.txt"), "x");
    expect(await removeInside(root, join(root, "a"))).toBe(true);
    expect(existsSync(join(root, "a"))).toBe(false);
  });

  it("answers false when nothing is there", async () => {
    expect(await removeInside(root, join(root, "missing"))).toBe(false);
  });

  it("refuses the root itself", async () => {
    await expect(removeInside(root, root)).rejects.toThrow(root);
    expect(existsSync(root)).toBe(true);
  });

  it("refuses a path outside the root and names both paths", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    await expect(removeInside(root, outside)).rejects.toThrow(`${outside}`);
    await expect(removeInside(root, outside)).rejects.toThrow(root);
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses a .. escape", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    await expect(removeInside(root, join(root, "..", "outside"))).rejects.toThrow("not inside");
    expect(existsSync(outside)).toBe(true);
  });

  it("removes a symlink but keeps what it points to", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    symlinkSync(outside, join(root, "link"));
    expect(await removeInside(root, join(root, "link"))).toBe(true);
    expect(existsSync(join(root, "link"))).toBe(false);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("refuses a path through a symlinked folder that leads out of the root", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    symlinkSync(outside, join(root, "link"));
    await expect(removeInside(root, join(root, "link", "keep.txt"))).rejects.toThrow("not inside");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});
