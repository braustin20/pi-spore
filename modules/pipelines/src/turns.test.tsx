// @vitest-environment happy-dom
import type { PipelineRun, PipelineTurn } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { openFindings } from "./turns.js";

const turn = (more: Partial<PipelineTurn>): PipelineTurn => ({
  id: "t1",
  runId: "r1",
  stageIndex: 0,
  stage: "review",
  round: 1,
  kind: "review",
  role: "reviewer",
  agentId: "a1",
  createdAt: 0,
  ...more,
});

const REVIEW = turn({
  report: {
    turn: "t1",
    summary: "Needs work",
    verdict: "revise",
    findings: [
      { severity: "minor", title: "Naming" },
      { severity: "blocking", title: "Crash on empty input", file: "src/a.ts", line: 12 },
    ],
    earlyStop: { stop: false, probability: 0.2 },
  },
});

describe("openFindings", () => {
  it("counts the latest reported review by severity", () => {
    const run = { turns: [REVIEW, turn({ id: "t2", kind: "fix", role: "worker" })] } as PipelineRun;
    expect(openFindings(run)).toEqual({ blocking: 1, important: 0, minor: 1 });
  });
});
