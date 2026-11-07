import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeOps, PublishOps } from "@pi-spore/mod-projects/server";
import { exec } from "@pi-spore/server-core";
import type { ChangedFile, Project } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitProvider } from "./server.js";

let root: string;
let repo: string;
let changes: ChangeOps;
let publish: PublishOps;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

const project = (): Project => ({
  id: "p",
  name: "p",
  slug: "p",
  path: repo,
  vcs: "git",
  traits: [],
  createdAt: 0,
});
const here = () => ({ path: repo });
const LIMITS = { maxLines: 1000, maxBytes: 100_000 };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-changes-")));
  repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "old.txt"), "moved\nfile\n");
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  writeFileSync(join(repo, ".gitignore"), "secret.env\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const provider = createGitProvider(exec, join(root, "worktrees"));
  if (!provider.changes || !provider.publish) throw new Error("git has no changes or publish");
  changes = provider.changes;
  publish = provider.publish;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const summary = (files: ChangedFile[]) =>
  files.map((file) =>
    [
      file.status,
      file.oldPath ? `${file.oldPath}->${file.path}` : file.path,
      file.additions,
      file.deletions,
      file.binary,
    ].join(" "),
  );

describe("git changes", () => {
  it("lists uncommitted changes with counts: modified, renamed, deleted, new, and binary files", async () => {
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    git(repo, "mv", "old.txt", "new.txt");
    git(repo, "rm", "-q", "gone.txt");
    writeFileSync(join(repo, "fresh.txt"), "x\ny\n");
    writeFileSync(join(repo, "pic.bin"), Buffer.from([0, 1, 2, 0]));
    writeFileSync(join(repo, "secret.env"), "TOKEN=1\n");

    const { files, truncated } = await changes.files(here(), { kind: "uncommitted" }, 100);
    expect(truncated).toBe(false);
    expect(summary(files)).toEqual([
      "modified a.txt 2 1 false",
      "added fresh.txt 2 0 false",
      "deleted gone.txt 0 1 false",
      "renamed old.txt->new.txt 0 0 false",
      "added pic.bin 0 0 true",
    ]);
  });

  it("shows a file's hunks with line numbers on both sides", async () => {
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour");
    const { files } = await changes.files(here(), { kind: "uncommitted" }, 100);
    const diff = await changes.diff(
      here(),
      { kind: "uncommitted" },
      files[0] as ChangedFile,
      LIMITS,
    );
    expect(diff.note).toBeUndefined();
    expect(diff.hunks).toEqual([
      {
        oldStart: 1,
        newStart: 1,
        section: "",
        lines: [
          { kind: "context", oldLine: 1, newLine: 1, text: "one" },
          { kind: "del", oldLine: 2, text: "two" },
          { kind: "add", newLine: 2, text: "TWO" },
          { kind: "context", oldLine: 3, newLine: 3, text: "three" },
          { kind: "add", newLine: 4, text: "four", noNewline: true },
        ],
      },
    ]);
  });

  it("shows a new untracked file as all added lines, and binary or large files as a note", async () => {
    writeFileSync(join(repo, "fresh.txt"), "x\ny\n");
    writeFileSync(join(repo, "pic.bin"), Buffer.from([0, 1, 2, 0]));
    const { files } = await changes.files(here(), { kind: "uncommitted" }, 100);
    const [fresh, pic] = files;

    const diff = await changes.diff(here(), { kind: "uncommitted" }, fresh as ChangedFile, LIMITS);
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: "add", newLine: 1, text: "x" },
      { kind: "add", newLine: 2, text: "y" },
    ]);
    expect(
      (await changes.diff(here(), { kind: "uncommitted" }, pic as ChangedFile, LIMITS)).note,
    ).toBe("binary");
    expect(
      (
        await changes.diff(here(), { kind: "uncommitted" }, fresh as ChangedFile, {
          maxLines: 1,
          maxBytes: 100_000,
        })
      ).note,
    ).toBe("too_large");
    expect(
      (
        await changes.diff(here(), { kind: "uncommitted" }, fresh as ChangedFile, {
          maxLines: 100,
          maxBytes: 20,
        })
      ).note,
    ).toBe("too_large");
  });

  it("separates staged changes from the rest", async () => {
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
    git(repo, "add", "a.txt");
    writeFileSync(join(repo, "gone.txt"), "changed\n");
    expect(summary((await changes.files(here(), { kind: "staged" }, 100)).files)).toEqual([
      "modified a.txt 1 1 false",
    ]);
  });

  it("shows every commit on the branch since its base, and one commit on its own", async () => {
    git(repo, "checkout", "-q", "-b", "work");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\n");
    git(repo, "commit", "-q", "-am", "add four");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "add b");
    // A commit on main after the branch left it is not part of the branch's changes.
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "main.txt"), "m\n");
    git(repo, "add", "main.txt");
    git(repo, "commit", "-q", "-m", "on main");
    git(repo, "checkout", "-q", "work");

    const records = await changes.records(here(), "main", 50);
    expect(records.map((record) => record.subject)).toEqual(["add b", "add four"]);
    expect(records[0]).toMatchObject({ author: "Test", shortId: expect.any(String) });

    expect(
      summary((await changes.files(here(), { kind: "line", base: "main" }, 100)).files),
    ).toEqual(["modified a.txt 1 0 false", "added b.txt 1 0 false"]);
    const one = await changes.files(
      here(),
      { kind: "record", id: (records[1] as { id: string }).id },
      100,
    );
    expect(summary(one.files)).toEqual(["modified a.txt 1 0 false"]);

    // The first commit has no parent; it diffs against nothing.
    const first = git(repo, "rev-list", "--max-parents=0", "HEAD").trim();
    expect((await changes.files(here(), { kind: "record", id: first }, 100)).files).toHaveLength(4);
  });

  it("refuses a base or a commit id that is not a commit, and option-like names", async () => {
    await expect(changes.files(here(), { kind: "line", base: "nope" }, 100)).rejects.toMatchObject({
      code: "base_not_found",
    });
    await expect(
      changes.files(here(), { kind: "line", base: "--output=/tmp/x" }, 100),
    ).rejects.toMatchObject({ code: "base_not_found" });
    await expect(changes.files(here(), { kind: "record", id: "--all" }, 100)).rejects.toMatchObject(
      { code: "bad_record" },
    );
    await expect(
      changes.files(here(), { kind: "record", id: "deadbeef" }, 100),
    ).rejects.toMatchObject({ code: "record_not_found" });
  });

  it("cuts the file list at the limit and says so", async () => {
    for (const name of ["f1", "f2", "f3"]) writeFileSync(join(repo, name), "x\n");
    const { files, truncated } = await changes.files(here(), { kind: "uncommitted" }, 2);
    expect(files).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("finds the default base from origin's HEAD, else main", async () => {
    expect(await changes.defaultBase(project())).toBe("main");
    const clone = join(root, "clone");
    git(root, "clone", "-q", repo, clone);
    git(clone, "branch", "-q", "-m", "main", "local-only");
    repo = clone;
    expect(await changes.defaultBase(project())).toBe("origin/main");
  });
});

describe("git publish", () => {
  it("pushes the branch to origin with an upstream, and never forces a rejected push", async () => {
    const origin = join(root, "origin.git");
    git(root, "init", "-q", "--bare", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "checkout", "-q", "-b", "work");
    writeFileSync(join(repo, "a.txt"), "pushed\n");
    git(repo, "commit", "-q", "-am", "work");

    expect(await publish.push(here(), "work")).toEqual({ remote: "origin" });
    expect(git(origin, "rev-parse", "work").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(git(repo, "rev-parse", "--abbrev-ref", "work@{upstream}").trim()).toBe("origin/work");

    // Someone else's commit on the remote branch: a plain push is rejected and the remote keeps it.
    const other = join(root, "other");
    git(root, "clone", "-q", "-b", "work", origin, other);
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "theirs");
    git(other, "push", "-q", "origin", "work");
    const theirs = git(origin, "rev-parse", "work").trim();
    git(repo, "commit", "-q", "--amend", "-m", "rewritten");

    await expect(publish.push(here(), "work")).rejects.toMatchObject({ code: "push_failed" });
    expect(git(origin, "rev-parse", "work").trim()).toBe(theirs);
  });

  it("says when there is no remote", async () => {
    await expect(publish.push(here(), "main")).rejects.toMatchObject({ code: "no_remote" });
  });
});
