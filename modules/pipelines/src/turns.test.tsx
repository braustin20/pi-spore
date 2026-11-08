// @vitest-environment happy-dom
import type { PipelineRun, PipelineTurn } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { openFindings, TurnList } from "./turns.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

async function render(turns: PipelineTurn[]) {
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(<TurnList turns={turns} workspaceId="w1" />);
  });
  return container;
}

describe("TurnList", () => {
  it("shows a review's verdict, findings by severity with file:line, and the chat link", async () => {
    const root = await render([
      turn({ id: "t0", kind: "task", role: "worker", agentId: "a0", round: 1 }),
      REVIEW,
    ]);

    const text = root.textContent ?? "";
    expect(text).toContain("Revise");
    expect(text).toContain("Blocking · 1");
    expect(text).toContain("src/a.ts:12");
    expect(text.indexOf("Blocking")).toBeLessThan(text.indexOf("Minor"));
    expect(text).toContain("Jev: keep reviewing (20%)");
    expect(text).toContain("Waiting for the report.");
    expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "#/workspaces/w1/chats/a0",
      "#/workspaces/w1/chats/a1",
    ]);
  });

  it("lists the worker's tests with their proof paths", async () => {
    const root = await render([
      turn({
        kind: "task",
        role: "worker",
        report: {
          turn: "t1",
          summary: "Done",
          tests: [{ name: "adds", proof: "proofs/adds.txt" }],
        },
      }),
    ]);
    expect(root.textContent).toContain("adds");
    expect(root.textContent).toContain("proofs/adds.txt");
  });
});

describe("openFindings", () => {
  it("counts the latest reported review by severity", () => {
    const run = { turns: [REVIEW, turn({ id: "t2", kind: "fix", role: "worker" })] } as PipelineRun;
    expect(openFindings(run)).toEqual({ blocking: 1, important: 0, minor: 1 });
  });
});
