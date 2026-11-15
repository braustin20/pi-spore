import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "@pi-spore/server-core";
import type { Project } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitProvider } from "./server.js";

let scratch: string;
let user: string;
let project: Project;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function commitFile(cwd: string, name: string, content: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", `edit ${name}`);
}

function projectAt(path: string): Project {
  return { id: "p", name: "p", slug: "p", path, vcs: "git", traits: [], createdAt: 0 };
}

function provider() {
  return createGitProvider(exec, join(scratch, "worktrees"));
}

/** `origin` is bare; `user` is a clone with one pushed commit on main. */
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-create-copy-")));
  const origin = join(scratch, "origin.git");
  git(scratch, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(scratch, "seed");
  git(scratch, "init", "-q", "-b", "main", seed);
  commitFile(seed, "a.txt", "one\n");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  user = join(scratch, "user");
  git(scratch, "clone", "-q", origin, user);
  project = projectAt(user);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A second clone adds two commits to origin's main and returns the new tip. */
function advanceOrigin(): string {
  const other = join(scratch, "other");
  git(scratch, "clone", "-q", join(scratch, "origin.git"), other);
  commitFile(other, "b.txt", "two\n");
  commitFile(other, "c.txt", "three\n");
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

describe("createCopy with isolation new", () => {
  it("starts from the upstream when the local base is behind it", async () => {
    const oldTip = git(user, "rev-parse", "main");
    const newTip = advanceOrigin();
    const path = join(scratch, "wt");

    const location = await provider().createCopy(project, {
      isolation: "new",
      path,
      line: "spore/x",
    });

    expect(git(path, "rev-parse", "HEAD")).toBe(newTip);
    expect(git(user, "rev-parse", "refs/heads/main")).toBe(oldTip);
    expect(location.base).toBe("main");
    expect(location.warnings ?? []).toEqual([]);
    expect(() => git(user, "config", "--get", "branch.spore/x.remote")).toThrow();
  });

  it("starts from the local base when it has commits origin lacks", async () => {
    advanceOrigin();
    commitFile(user, "local.txt", "mine\n");
    const local = git(user, "rev-parse", "main");
    const path = join(scratch, "wt");

    const location = await provider().createCopy(project, {
      isolation: "new",
      path,
      line: "spore/x",
    });

    expect(git(path, "rev-parse", "HEAD")).toBe(local);
    expect(location.base).toBe("main");
  });

  it("warns about the remote and starts from the local base when the fetch fails", async () => {
    git(user, "config", "remote.origin.url", join(scratch, "missing.git"));
    const local = git(user, "rev-parse", "main");
    const path = join(scratch, "wt");

    const location = await provider().createCopy(project, {
      isolation: "new",
      path,
      line: "spore/x",
    });

    expect(git(path, "rev-parse", "HEAD")).toBe(local);
    expect(location.warnings).toHaveLength(1);
    expect(location.warnings?.[0]).toContain("origin");
  });

  it("starts from a local upstream that is ahead of the base, and leaves the base alone", async () => {
    const lone = join(scratch, "lone");
    git(scratch, "init", "-q", "-b", "main", lone);
    commitFile(lone, "a.txt", "one\n");
    git(lone, "branch", "stale");
    const staleTip = git(lone, "rev-parse", "stale");
    commitFile(lone, "b.txt", "two\n");
    git(lone, "branch", "--set-upstream-to=main", "stale");
    const path = join(scratch, "wt");

    const location = await provider().createCopy(projectAt(lone), {
      isolation: "new",
      path,
      line: "spore/x",
      base: "stale",
    });

    expect(git(path, "rev-parse", "HEAD")).toBe(git(lone, "rev-parse", "main"));
    expect(git(lone, "rev-parse", "refs/heads/stale")).toBe(staleTip);
    expect(location.base).toBe("stale");
    expect(location.warnings ?? []).toEqual([]);
  });

  it("does not let a fetch refspec move a local base branch", async () => {
    const oldTip = git(user, "rev-parse", "main");
    advanceOrigin();
    git(user, "switch", "-q", "-c", "elsewhere");
    git(user, "config", "remote.origin.fetch", "+refs/heads/main:refs/heads/main");
    const path = join(scratch, "wt");

    const location = await provider().createCopy(project, {
      isolation: "new",
      path,
      line: "spore/x",
      base: "main",
    });

    expect(git(user, "rev-parse", "refs/heads/main")).toBe(oldTip);
    expect(git(path, "rev-parse", "HEAD")).toBe(oldTip);
    expect(location.warnings).toHaveLength(1);
    expect(location.warnings?.[0]).toContain("origin");
  });

  it("works in a repo with no remote", async () => {
    const lone = join(scratch, "lone");
    git(scratch, "init", "-q", "-b", "main", lone);
    commitFile(lone, "a.txt", "one\n");
    const path = join(scratch, "wt");

    const location = await provider().createCopy(projectAt(lone), {
      isolation: "new",
      path,
      line: "spore/x",
    });

    expect(git(path, "rev-parse", "HEAD")).toBe(git(lone, "rev-parse", "main"));
    expect(location.base).toBe("main");
    expect(location.warnings ?? []).toEqual([]);
  });
});
