import type { DiffHunk, DiffLine } from "@pi-spore/shared";
import { highlightLines, type Token } from "./highlight.js";

/** A diff line with its colored tokens. */
export interface ShownLine {
  line: DiffLine;
  tokens: Token[];
}

/** A row of the split view: the old side on the left, the new side on the right. */
export interface SplitRow {
  left?: ShownLine;
  right?: ShownLine;
}

/**
 * Colors a hunk. Each side is colored as one block (old: context and deleted lines; new: context and added lines),
 * so constructs over several lines keep their color.
 */
export function colorHunk(hunk: DiffHunk, language: string | undefined): ShownLine[] {
  const oldSide = hunk.lines.filter((line) => line.kind !== "add");
  const newSide = hunk.lines.filter((line) => line.kind !== "del");
  const oldTokens = highlightLines(
    oldSide.map((line) => line.text),
    language,
  );
  const newTokens = highlightLines(
    newSide.map((line) => line.text),
    language,
  );
  let o = 0;
  let n = 0;
  return hunk.lines.map((line) => {
    if (line.kind === "del") return { line, tokens: oldTokens[o++] ?? [] };
    if (line.kind === "add") return { line, tokens: newTokens[n++] ?? [] };
    o++;
    return { line, tokens: newTokens[n++] ?? [] };
  });
}

/** Pairs a hunk's lines for the split view: context on both sides, each run of deletions next to the additions after it. */
export function splitRows(lines: readonly ShownLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: ShownLine[] = [];
  let adds: ShownLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i];
      const right = adds[i];
      rows.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
    dels = [];
    adds = [];
  };
  for (const shown of lines) {
    if (shown.line.kind === "context") {
      flush();
      rows.push({ left: shown, right: shown });
    } else if (shown.line.kind === "del") {
      if (adds.length > 0) flush();
      dels.push(shown);
    } else adds.push(shown);
  }
  flush();
  return rows;
}
