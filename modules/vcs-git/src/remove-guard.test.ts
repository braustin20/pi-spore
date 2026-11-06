import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "@pi-spore/server-core";
import type { Project } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitProvider } from "./server.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-spore-guard-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createGitProvider removeCopy", () => {
  it.each([
    [
      "a folder outside the worktrees folder",
      (worktrees: string) => join(worktrees, "..", "precious"),
    ],
    ["the worktrees folder itself", (worktrees: string) => worktrees],
  ])("refuses to remove %s, even when forced", async (_label, target) => {
    const worktrees = join(root, "worktrees");
    mkdirSync(worktrees);
    const victim = target(worktrees);
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "keep");
    const project: Project = {
      id: "p",
      name: "p",
      slug: "p",
      path: root,
      vcs: "x",
      traits: [],
      createdAt: 0,
    };

    await expect(
      createGitProvider(exec, worktrees).removeCopy(project, { path: victim }, { force: true }),
    ).rejects.toThrow("Refusing to remove");
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  });
});
