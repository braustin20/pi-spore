import type { DiffHunk } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { colorHunk, splitRows } from "./rows.js";

const hunk: DiffHunk = {
  oldStart: 1,
  newStart: 1,
  section: "",
  lines: [
    { kind: "context", oldLine: 1, newLine: 1, text: "a" },
    { kind: "del", oldLine: 2, text: "b" },
    { kind: "del", oldLine: 3, text: "c" },
    { kind: "add", newLine: 2, text: "B" },
    { kind: "context", oldLine: 4, newLine: 3, text: "d" },
    { kind: "add", newLine: 4, text: "e" },
  ],
};

const text = (shown?: { line: { text: string } }) => shown?.line.text ?? "·";

describe("splitRows", () => {
  it("pairs each run of deletions with the additions after it, and context on both sides", () => {
    const rows = splitRows(colorHunk(hunk, undefined));
    expect(rows.map((row) => `${text(row.left)}|${text(row.right)}`)).toEqual([
      "a|a",
      "b|B",
      "c|·",
      "d|d",
      "·|e",
    ]);
  });
});

describe("colorHunk", () => {
  it("gives each line the tokens of its own side", () => {
    const shown = colorHunk(hunk, undefined);
    expect(shown.map((line) => line.tokens.map((token) => token.text).join(""))).toEqual([
      "a",
      "b",
      "c",
      "B",
      "d",
      "e",
    ]);
  });
});
