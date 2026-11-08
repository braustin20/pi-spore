import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceLocation } from "@pi-spore/mod-projects/server";
import { exec } from "@pi-spore/server-core";
import type { Project } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitIntegrate } from "./integrate.js";

let scratch: string;
let repo: string;
let project: Project;
const integrate = createGitIntegrate(exec);

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

function commitFile(cwd: string, name: string, content: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", `edit ${name}`);
}

/** Commits made through the provider need an identity; the test repo sets one instead of the provider. */
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-integrate-")));
  repo = join(scratch, "repo");
  git(scratch, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  commitFile(repo, "a.txt", "one\n");
  project = {
    id: "p",
    name: "p",
    slug: "p",
    path: repo,
    vcs: "git",
    traits: [],
    createdAt: 0,
  };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy on `run/x`, and a lane branch `lane/a` with one commit on its own file. */
async function runWithLane(): Promise<WorkspaceLocation> {
  await integrate.createLine(project, "run/x", "main");
  await integrate.createLine(project, "lane/a", "run/x");
  const lane = join(scratch, "lane");
  git(repo, "worktree", "add", "-q", lane, "lane/a");
  commitFile(lane, "lane.txt", "lane\n");
  const copy = join(scratch, "run");
  git(repo, "worktree", "add", "-q", copy, "run/x");
  return { path: copy, line: "run/x" };
}

describe("createGitIntegrate", () => {
  it("createLine makes the branch and leaves HEAD alone", async () => {
    const head = git(repo, "rev-parse", "HEAD").trim();
    await integrate.createLine(project, "run/x", "main");
    expect(git(repo, "rev-parse", "run/x").trim()).toBe(head);
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    await expect(integrate.createLine(project, "run/x", "main")).rejects.toMatchObject({
      status: 409,
      code: "git_failed",
    });
  });

  it("merges and commits a lane into the run line and leaves main alone", async () => {
    const copy = await runWithLane();
    const main = git(repo, "rev-parse", "main").trim();

    expect(await integrate.merge(copy, "lane/a")).toEqual({ conflicts: [] });
    expect(existsSync(join(copy.path, "lane.txt"))).toBe(true);
    git(copy.path, "rev-parse", "-q", "--verify", "MERGE_HEAD");

    const sha = await integrate.commit(copy, "Merge lane a");
    expect(git(repo, "rev-parse", "run/x").trim()).toBe(sha);
    expect(git(repo, "rev-list", "--parents", "-n1", sha).trim().split(" ")).toHaveLength(3);
    expect(git(repo, "rev-parse", "main").trim()).toBe(main);

    expect(await integrate.merge(copy, "lane/a")).toEqual({ conflicts: [] });
  });

  it("returns the conflicted files and leaves a clean tree", async () => {
    const copy = await runWithLane();
    commitFile(copy.path, "a.txt", "run\n");
    const lane = join(scratch, "lane");
    commitFile(lane, "a.txt", "lane\n");
    const head = git(copy.path, "rev-parse", "HEAD").trim();

    expect(await integrate.merge(copy, "lane/a")).toEqual({ conflicts: ["a.txt"] });
    expect(git(copy.path, "status", "--porcelain").trim()).toBe("");
    expect(git(copy.path, "rev-parse", "HEAD").trim()).toBe(head);
    expect(() => git(copy.path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
  });

  it("refuses merge, commit, and abort in a copy that is not on a run/ branch", async () => {
    await runWithLane();
    const main = git(repo, "rev-parse", "main").trim();
    const onMain: WorkspaceLocation = { path: repo, line: "main" };

    for (const attempt of [
      () => integrate.merge(onMain, "lane/a"),
      () => integrate.commit(onMain, "Merge"),
      () => integrate.abort(onMain),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ status: 409, code: "not_run_line" });
    }
    expect(git(repo, "rev-parse", "main").trim()).toBe(main);
    expect(existsSync(join(repo, "lane.txt"))).toBe(false);
  });

  it("abort undoes a merge in progress and does nothing without one", async () => {
    const copy = await runWithLane();
    await integrate.abort(copy);

    await integrate.merge(copy, "lane/a");
    await integrate.abort(copy);
    expect(existsSync(join(copy.path, "lane.txt"))).toBe(false);
    expect(() => git(copy.path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
  });

  it("diff shows what the lane added since it left the run line", async () => {
    const copy = await runWithLane();
    commitFile(copy.path, "other.txt", "other\n");
    const patch = await integrate.diff(copy, "lane/a");
    expect(patch).toContain("+++ b/lane.txt");
    expect(patch).toContain("+lane");
    expect(patch).not.toContain("other.txt");
  });
});
