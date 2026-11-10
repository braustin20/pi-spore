// @vitest-environment happy-dom
import type { PipelineRun, PipelineTurn } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StepBar, Timeline } from "./timeline.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;

const turn = (more: Partial<PipelineTurn>): PipelineTurn => ({
  id: "t1",
  runId: "r1",
  stageIndex: 1,
  stage: "review",
  round: 1,
  kind: "review",
  role: "reviewer",
  agentId: "a1",
  createdAt: 0,
  ...more,
});

const run = (more: Partial<PipelineRun>): PipelineRun => ({
  id: "r1",
  workspaceId: "w1",
  pipelineId: "default",
  source: "built-in",
  hash: "h",
  stages: [
    { name: "implement", role: "worker" },
    { name: "review", role: "reviewer", rounds: 2 },
    { name: "verify", gates: ["check", "test"] },
  ],
  brief: "b",
  askingAgentId: "chat",
  state: "running",
  stageIndex: 1,
  tests: [],
  turns: [],
  createdAt: 0,
  ...more,
});

const TASK = turn({
  id: "t-task",
  stageIndex: 0,
  stage: "implement",
  kind: "task",
  role: "worker",
  agentId: "a-task",
  createdAt: 1000,
  reportedAt: 1000 + 45_000,
  report: { turn: "t-task", summary: "Built it" },
});
const REVIEW1 = turn({
  id: "t-r1",
  createdAt: 100_000,
  reportedAt: 100_000 + 3 * MIN,
  report: {
    turn: "t-r1",
    summary: "Needs work\nsecond line",
    verdict: "revise",
    findings: [
      { severity: "blocking", title: "Crash on empty input", file: "src/a.ts", line: 12 },
      { severity: "blocking", title: "Leaks a handle" },
      { severity: "minor", title: "Naming" },
    ],
  },
});
const FIX = turn({
  id: "t-fix",
  stageIndex: 1,
  stage: "review",
  kind: "fix",
  role: "worker",
  agentId: "a-fix",
  createdAt: 400_000,
  reportedAt: 410_000,
  report: { turn: "t-fix", summary: "Fixed both" },
});
const REVIEW2 = turn({
  id: "t-r2",
  round: 2,
  createdAt: 500_000,
  reportedAt: 520_000,
  report: { turn: "t-r2", summary: "Good now", verdict: "approve" },
});

let container: HTMLElement | undefined;
let reactRoot: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => reactRoot?.unmount());
  container?.remove();
});

async function mount(element: React.ReactElement) {
  container = document.body.appendChild(document.createElement("div"));
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(element));
  return container;
}

const rows = (root: HTMLElement) => [...root.querySelectorAll("li > button[aria-expanded]")];
const expanded = (root: HTMLElement) => rows(root).map((row) => row.getAttribute("aria-expanded"));

describe("Timeline", () => {
  it("lists the turns by createdAt, numbered from 1, whatever the array order", async () => {
    const input = [REVIEW2, FIX, TASK, REVIEW1];
    const root = await mount(
      <Timeline run={run({ turns: input })} workspaceId="w1" now={600_000} />,
    );
    const texts = rows(root).map((row) => row.textContent ?? "");
    expect(texts).toHaveLength(4);
    expect(texts[0]).toMatch(/^1.*implement.*Task/);
    expect(texts[1]).toMatch(/^2.*review.*Review, round 1/);
    // A fix belongs to the worker stage, and says which review it answers.
    expect(texts[2]).toMatch(/^3.*implement.*Fix for review round 1/);
    expect(texts[3]).toMatch(/^4.*review.*Review, round 2/);
    expect(input.map((entry) => entry.id)).toEqual(["t-r2", "t-fix", "t-task", "t-r1"]);
  });

  it("opens only the last row at first, and keeps a row the user opened when a turn arrives", async () => {
    const turns = [TASK, REVIEW1, FIX];
    const root = await mount(<Timeline run={run({ turns })} workspaceId="w1" now={600_000} />);
    expect(expanded(root)).toEqual(["false", "false", "true"]);

    await act(async () => (rows(root)[0] as HTMLElement).click());
    expect(expanded(root)).toEqual(["true", "false", "true"]);

    await act(async () =>
      reactRoot?.render(
        <Timeline run={run({ turns: [...turns, REVIEW2] })} workspaceId="w1" now={600_000} />,
      ),
    );
    expect(expanded(root)).toEqual(["true", "false", "false", "true"]);
  });

  it("shows the verdict, the blocking count, and the duration on a closed row", async () => {
    const root = await mount(
      <Timeline run={run({ turns: [REVIEW1, REVIEW2] })} workspaceId="w1" now={600_000} />,
    );
    const first = rows(root)[0]?.textContent ?? "";
    expect(first).toContain("Revise");
    expect(first).toContain("2 blocking");
    expect(first).toContain("1 minor");
    expect(first).toContain("3 min");
    // The headline is the first line of the summary only.
    expect(root.textContent).toContain("Needs work");
    expect(root.textContent).not.toContain("second line");
  });

  it("keeps minor findings in a closed group and shows blocking ones", async () => {
    const root = await mount(
      <Timeline run={run({ turns: [REVIEW1] })} workspaceId="w1" now={600_000} />,
    );
    expect(root.textContent).toContain("Crash on empty input");
    expect(root.textContent).toContain("src/a.ts:12");
    expect(root.textContent).not.toContain("Naming");
    const group = root.querySelector('button[data-state="closed"]');
    expect(group?.textContent).toContain("1 minor");
  });

  it("shows a Gates row with no escape codes when the run failed at a gates stage", async () => {
    const failed = run({
      state: "failed",
      stageIndex: 2,
      message: "\u001b[31mFAIL\u001b[0m src/a.test.ts\n\u001b[1;32mok\u001b[0m",
      turns: [TASK, REVIEW1],
    });
    const root = await mount(<Timeline run={failed} workspaceId="w1" now={600_000} />);
    const gates = rows(root)[2];
    expect(gates?.textContent).toContain("Gates: check, test");
    const log = root.querySelector("pre");
    expect(log?.textContent).toContain("FAIL src/a.test.ts");
    expect(log?.textContent).not.toContain("\u001b");
  });

  it("says how long a turn without a report has been running, from now", async () => {
    const running = turn({ id: "t-run", createdAt: 100_000 });
    const root = await mount(
      <Timeline run={run({ turns: [running] })} workspaceId="w1" now={100_000 + 3 * MIN} />,
    );
    expect(rows(root)[0]?.textContent).toContain("running 3 min");
    expect(root.textContent).toContain("Waiting for the report.");
  });

  it("does not call a turn of a stopped run running", async () => {
    const left = turn({ id: "t-left", createdAt: 100_000 });
    const root = await mount(
      <Timeline
        run={run({ state: "stopped", turns: [left] })}
        workspaceId="w1"
        now={100_000 + 3 * MIN}
      />,
    );
    expect(rows(root)[0]?.textContent).not.toContain("running");
  });
});

describe("StepBar", () => {
  const labels = (root: HTMLElement) =>
    [...root.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));

  it("shows done, running, and not started stages of a running run", async () => {
    const root = await mount(<StepBar run={run({ stageIndex: 1 })} onStep={() => {}} />);
    expect(labels(root)).toEqual(["implement: done", "review: running", "verify: not started"]);
  });

  it("shows the stage a failed run stopped at as failed", async () => {
    const root = await mount(
      <StepBar run={run({ state: "failed", stageIndex: 1 })} onStep={() => {}} />,
    );
    expect(labels(root)).toEqual(["implement: done", "review: failed", "verify: not started"]);
  });

  it("counts review rounds and fixes, and reports the clicked stage", async () => {
    const clicked: number[] = [];
    const root = await mount(
      <StepBar
        run={run({ turns: [TASK, REVIEW1, FIX, REVIEW2] })}
        onStep={(index) => clicked.push(index)}
      />,
    );
    expect(root.textContent).toContain("implement · 1 fix");
    expect(root.textContent).toContain("review · 2 rounds");
    await act(async () => (root.querySelectorAll("button")[1] as HTMLElement).click());
    expect(clicked).toEqual([1]);
  });
});
