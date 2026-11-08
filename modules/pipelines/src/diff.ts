import type { ChangeOps, WorkspaceLocation } from "@pi-spore/mod-projects/server";
import type { ChangeScope, DiffHunk, FileDiff } from "@pi-spore/shared";

/** Same bounds as the Changes tab: a larger file or list gets a note instead of its lines. */
const MAX_FILES = 1000;
const MAX_DIFF_FILES = 200;
const LIMITS = { maxLines: 3000, maxBytes: 512 * 1024 };

export const NO_DIFF = [
  "# No diff",
  "",
  "This project has no version control that shows changes, so pi-spore cannot make a diff.",
  "Read the files in the workspace instead.",
  "",
].join("\n");

const hunkText = (hunk: DiffHunk): string[] => {
  const oldLength = hunk.lines.filter((line) => line.kind !== "add").length;
  const newLength = hunk.lines.filter((line) => line.kind !== "del").length;
  const section = hunk.section === "" ? "" : ` ${hunk.section}`;
  const lines = hunk.lines.flatMap((line) => {
    const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    return line.noNewline
      ? [`${marker}${line.text}`, "\\ No newline at end of file"]
      : [`${marker}${line.text}`];
  });
  return [
    `@@ -${hunk.oldStart},${oldLength} +${hunk.newStart},${newLength} @@${section}`,
    ...lines,
  ];
};

const fileText = ({ file, hunks, note }: FileDiff): string[] => {
  const from = file.status === "added" ? "/dev/null" : `a/${file.oldPath ?? file.path}`;
  const to = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
  const head = [`diff ${file.status} ${file.path}`];
  if (note === "binary") return [...head, "(binary file: its diff is not shown)"];
  if (note === "too_large") return [...head, "(too large: its diff is not shown; read the file)"];
  return [...head, `--- ${from}`, `+++ ${to}`, ...hunks.flatMap(hunkText)];
};

/** One scope as a section of unified diff text, with a note for each file or list that was cut short. */
async function section(
  ops: ChangeOps,
  location: WorkspaceLocation,
  scope: ChangeScope,
  title: string,
): Promise<string[]> {
  const listed = await ops.files(location, scope, MAX_FILES);
  const shown = listed.files.slice(0, MAX_DIFF_FILES);
  const lines = [`## ${title}`, ""];
  if (shown.length === 0) lines.push("(no changes)", "");
  for (const file of shown) {
    lines.push(...fileText(await ops.diff(location, scope, file, LIMITS)), "");
  }
  if (listed.truncated || listed.files.length > shown.length) {
    lines.push("(more files changed than this diff holds; read the workspace for the rest)", "");
  }
  return lines;
}

/**
 * The reviewer's diff: the commits since `base`, then the uncommitted and untracked files. Without a base only the
 * second part exists, and the text says so.
 */
export async function renderDiff(
  ops: ChangeOps,
  location: WorkspaceLocation,
  base: string | undefined,
): Promise<string> {
  const committed = base
    ? await section(ops, location, { kind: "line", base }, `Committed since ${base}`)
    : [
        "## Committed changes",
        "",
        "(the workspace has no base, so committed changes are not listed)",
        "",
      ];
  const uncommitted = await section(
    ops,
    location,
    { kind: "uncommitted" },
    "Uncommitted and untracked",
  );
  return ["# Diff", "", ...committed, ...uncommitted].join("\n");
}
