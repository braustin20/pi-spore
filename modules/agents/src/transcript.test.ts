import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscript } from "./transcript.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-spore-transcript-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(...entries: object[]): string {
  const path = join(dir, "s.jsonl");
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

const user = (id: string, parentId: string | null, text: string, timestamp: number) => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: text, timestamp },
});

describe("readTranscript", () => {
  it("reads the folder, the active branch's messages, and the last model and thinking level", async () => {
    const path = session(
      { type: "session", version: 3, id: "s", cwd: "/work/game" },
      { type: "model_change", id: "m1", parentId: null, provider: "a", modelId: "one" },
      {
        type: "message",
        id: "sys",
        parentId: "m1",
        message: { role: "system", content: "", timestamp: 1 },
      },
      user("u1", "sys", "first", 2),
      { type: "model_change", id: "m2", parentId: "u1", provider: "b", modelId: "two" },
      { type: "thinking_level_change", id: "t1", parentId: "m2", thinkingLevel: "low" },
      user("u2", "t1", "second", 3),
    );

    const transcript = await readTranscript(path);

    expect(transcript.cwd).toBe("/work/game");
    expect(transcript.messages.map((message) => message.content)).toEqual(["first", "second"]);
    expect(transcript.model).toEqual({ provider: "b", id: "two" });
    expect(transcript.thinkingLevel).toBe("low");
  });

  it("follows the branch from the last entry and ignores abandoned ones", async () => {
    const path = session(
      { type: "session", version: 3, id: "s", cwd: "/w" },
      user("a", null, "root", 1),
      user("b", "a", "abandoned", 2),
      { type: "model_change", id: "mb", parentId: "b", provider: "x", modelId: "abandoned-model" },
      user("c", "a", "kept", 3),
    );
    const transcript = await readTranscript(path);
    expect(transcript.messages.map((message) => message.content)).toEqual(["root", "kept"]);
    expect(transcript.model).toBeUndefined();
  });

  it("shows a compaction as a summary message and skips a broken last line", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/w" }),
        JSON.stringify(user("a", null, "early", 1)),
        JSON.stringify({
          type: "compaction",
          id: "c",
          parentId: "a",
          summary: "We fixed the build.",
          timestamp: "2026-11-06T12:00:00.000Z",
        }),
        '{"type":"message","id":"partial',
      ].join("\n"),
    );
    const transcript = await readTranscript(path);
    expect(transcript.messages).toEqual([
      { role: "user", content: "early", timestamp: 1 },
      {
        role: "compaction",
        content: "We fixed the build.",
        timestamp: Date.parse("2026-11-06T12:00:00.000Z"),
      },
    ]);
  });
});
