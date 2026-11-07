import { describe, expect, it } from "vitest";
import { parseChildRuns, parseInspectReply, runningCount } from "./child-runs.js";

const widget = (payload: unknown, prefix = "PI_SUBAGENT_ASYNC_JSON:") => [
  `${prefix}${JSON.stringify(payload)}`,
];

// Trimmed from a real pi-subagents 0.86.0 run (spike Q5), with the extra fields it sends.
const snapshot = {
  kind: "pi-subagents.async-status-snapshot",
  version: 1,
  generatedAt: 1794094264883,
  caps: { maxRuns: 20 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [
    {
      id: "238fb3d8",
      kind: "subagent",
      label: "scout",
      state: "running",
      startedAt: 1794094264136,
      updatedAt: 1794094264839,
      activity: { lastActivityAt: 1794094264839, currentTool: "read", turnCount: 2 },
      children: [
        {
          id: "step:0",
          kind: "step",
          label: "scout",
          state: "running",
          startedAt: 1794094264139,
          agent: "scout",
          model: "claude-bridge/claude-haiku-5-5",
          thinking: "low",
        },
      ],
    },
  ],
};

describe("parseChildRuns", () => {
  it("reads runs and steps, and leaves out what changes every second", () => {
    expect(parseChildRuns(widget(snapshot))).toEqual([
      {
        id: "238fb3d8",
        label: "scout",
        state: "running",
        currentTool: "read",
        startedAt: 1794094264136,
        steps: [
          {
            id: "step:0",
            label: "scout",
            state: "running",
            agent: "scout",
            model: "claude-bridge/claude-haiku-5-5",
            thinking: "low",
            startedAt: 1794094264139,
          },
        ],
      },
    ]);
  });

  it("treats a cleared widget as no runs", () => {
    expect(parseChildRuns(undefined)).toEqual([]);
  });

  it.each([
    ["a version it does not know", widget({ ...snapshot, version: 2 })],
    ["another kind", widget({ ...snapshot, kind: "other" })],
    [
      "a run with an unknown state",
      widget({ ...snapshot, runs: [{ ...snapshot.runs[0], state: "lost" }] }),
    ],
    ["no prefix", [JSON.stringify(snapshot)]],
    ["broken JSON", ["PI_SUBAGENT_ASYNC_JSON:{"]],
    ["two lines", [...widget(snapshot), "more"]],
  ])("rejects %s", (_name, lines) => {
    expect(() => parseChildRuns(lines)).toThrow();
  });

  it("counts only running runs as processes", () => {
    const runs = ["queued", "running", "running", "complete", "paused"].map((state) => ({
      id: state,
      label: state,
      state: state as "running",
      steps: [],
    }));
    expect(runningCount(runs)).toBe(2);
  });
});

describe("parseInspectReply", () => {
  const prefix = "PI_SUBAGENT_INSPECT_JSON:";
  const base = { kind: "pi-subagents.inspect-reply", version: 1, requestId: "r1" };

  it("reads a transcript", () => {
    const result = parseInspectReply(
      widget(
        {
          ...base,
          asyncId: "238fb3d8",
          status: "complete",
          finalOutput: "hi",
          resolvedModel: { provider: "claude-bridge", model: "claude-haiku-5-5" },
          truncated: { task: false, messages: 3, finalOutput: false },
        },
        prefix,
      ),
    );
    expect(result).toEqual({
      requestId: "r1",
      transcript: {
        status: "complete",
        messages: [],
        finalOutput: "hi",
        model: "claude-bridge/claude-haiku-5-5",
        truncated: true,
      },
    });
  });

  it("passes on an error reply", () => {
    const error = { code: "stale", message: "Gone" };
    expect(parseInspectReply(widget({ ...base, error }, prefix))).toEqual({
      requestId: "r1",
      error,
    });
  });

  it("rejects a reply of the wrong kind", () => {
    expect(() => parseInspectReply(widget({ ...base, kind: "x" }, prefix))).toThrow();
  });
});
