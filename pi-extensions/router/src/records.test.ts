import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneRecords, routingFile } from "./records.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-spore-records-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const line = (at: unknown): string =>
  `${JSON.stringify({ at, kind: "initial", route: "cloud", reasons: [] })}\n`;

function writeLog(text: string): void {
  mkdirSync(dirname(routingFile(home)), { recursive: true });
  writeFileSync(routingFile(home), text);
}

const readLog = (): string => readFileSync(routingFile(home), "utf8");

describe("pruneRecords", () => {
  it("removes lines older than the limit and keeps the rest, in order", async () => {
    writeLog(line(10) + line(500) + line(20) + line(100));

    expect(await pruneRecords(home, 100)).toBe(2);
    expect(readLog()).toBe(line(500) + line(100));
  });

  it("keeps lines it cannot parse and lines without a numeric at", async () => {
    const odd = `not json\n{"kind":"initial"}\n{"at":"1"}\nnull\n{"at":`;
    writeLog(line(10) + odd);

    expect(await pruneRecords(home, 100)).toBe(1);
    expect(readLog()).toBe(odd);
  });

  it("answers 0 when the file is missing", async () => {
    expect(await pruneRecords(home, 100)).toBe(0);
  });

  it("does not rewrite the file when nothing is old", async () => {
    writeLog(line(500) + "not json\n");
    const before = statSync(routingFile(home));

    expect(await pruneRecords(home, 100)).toBe(0);
    const after = statSync(routingFile(home));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("leaves no temp file behind", async () => {
    writeLog(line(10) + line(500));
    await pruneRecords(home, 100);

    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dirname(routingFile(home)))).toEqual(["routing.jsonl"]);
  });
});
