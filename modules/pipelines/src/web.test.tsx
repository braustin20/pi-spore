// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import {
  GATE_LOG_HEADING,
  type PipelineRun,
  type PipelineTurn,
  type Workspace,
} from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipelinesWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const workspace = { id: "W1", state: "active" } as Workspace;

const turn = (more: Partial<PipelineTurn>): PipelineTurn => ({
  id: "t1",
  runId: "r1",
  stageIndex: 0,
  stage: "implement",
  round: 1,
  kind: "task",
  role: "worker",
  agentId: "a1",
  createdAt: 0,
  ...more,
});

const run = (more: Partial<PipelineRun>): PipelineRun => ({
  id: "r1",
  workspaceId: "W1",
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
  stageIndex: 0,
  tests: [],
  turns: [],
  createdAt: 0,
  ...more,
});

const TASK = turn({
  id: "t-task",
  createdAt: 10 * MIN,
  reportedAt: 10 * MIN + 45_000,
  report: { turn: "t-task", summary: "Built it" },
});
const REVIEW = turn({
  id: "t-review",
  stageIndex: 1,
  stage: "review",
  kind: "review",
  role: "reviewer",
  createdAt: 11 * MIN,
  reportedAt: 12 * MIN,
  report: { turn: "t-review", summary: "Looks fine", verdict: "approve" },
});

const DeclineNote = () => null;

let container: HTMLElement | undefined;
let reactRoot: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  // Only the clock: a faked promise queue would stall `act`.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  // A fixed start, so no test depends on the real date. A test may set its own time.
  vi.setSystemTime(0);
});
afterEach(() => {
  act(() => reactRoot?.unmount());
  container?.remove();
  vi.useRealTimers();
});

async function mount(first: PipelineRun[], startable: unknown[] = []) {
  let tab: ComponentType<{ workspace: Workspace }> | undefined;
  const view = {
    addTab: (added: { component: typeof tab }) => (tab = added.component),
    addPanel: () => {},
    addApprovalView: () => {},
    DeclineNote,
  };
  pipelinesWeb.setup({ use: () => view } as unknown as WebHost);
  if (!tab) throw new Error("the pipelines module did not add its tab");
  const Tab = tab;
  let listener: ((raw: unknown) => void) | undefined;
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const api = {
    get: async () => ({ pipelines: startable }),
    send: async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
    },
    subscribe: (_topic: string, onEvent: (raw: unknown) => void) => {
      listener = onEvent;
      onEvent({ type: "runs", runs: first });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  const root = container;
  reactRoot = createRoot(root);
  await act(async () =>
    reactRoot?.render(
      <ApiContext value={api}>
        <Tab workspace={workspace} />
      </ApiContext>,
    ),
  );
  const send = (runs: PipelineRun[]) => act(async () => listener?.({ type: "runs", runs }));
  return { root, send, sent };
}

const card = (root: HTMLElement, id: string) =>
  root.querySelector(`section[aria-label="Run of ${id}"]`) as HTMLElement;
const rows = (root: HTMLElement) => [...root.querySelectorAll("li > button[aria-expanded]")];
const expanded = (root: HTMLElement) => rows(root).map((row) => row.getAttribute("aria-expanded"));
const header = (section: HTMLElement) => section.firstElementChild as HTMLElement;
const toggle = (section: HTMLElement) => header(section).querySelector("button") as HTMLElement;

describe("Pipeline tab", () => {
  it("opens the newest run only, and opens an older run on a click", async () => {
    const newest = run({ id: "r2", pipelineId: "new", turns: [TASK] });
    const older = run({
      id: "r1",
      pipelineId: "old",
      state: "passed",
      stageIndex: 2,
      turns: [TASK, REVIEW],
    });
    const { root } = await mount([newest, older]);

    expect(rows(card(root, "new"))).toHaveLength(1);
    expect(rows(card(root, "old"))).toHaveLength(0);
    // The older run still shows its header and its step bar.
    expect(header(card(root, "old")).textContent).toContain("Passed");
    expect(card(root, "old").querySelector('button[aria-label="review: done"]')).not.toBeNull();

    await act(async () => toggle(card(root, "old")).click());
    // Two turns and the Gates row.
    expect(rows(card(root, "old"))).toHaveLength(3);
  });

  it("shows the elapsed time of an active run in the header, from the first turn to now", async () => {
    vi.setSystemTime(10 * MIN + 5 * MIN);
    const { root } = await mount([run({ turns: [TASK] })]);
    // Not "15 min": the run itself began at 0, before its first turn.
    const text = header(card(root, "default")).textContent;
    expect(text).toContain("5 min");
    expect(text).not.toContain("15 min");
  });

  it("shows the slice name in the header button, with the pipeline id as a chip after it", async () => {
    const { root } = await mount([run({ name: "push_line tool" })]);
    const named = header(card(root, "default"));
    expect(named.querySelector("button")?.textContent).toBe("push_line tool");
    expect(named.textContent).toMatch(/^push_line tooldefaultbuilt-inRunning/);
  });

  it("shows the pipeline id in the header button, and no extra chip, for a run with no name", async () => {
    const { root } = await mount([run({})]);
    const plain = header(card(root, "default"));
    expect(plain.querySelector("button")?.textContent).toBe("default");
    expect(plain.textContent).toMatch(/^defaultbuilt-inRunning/);
  });

  it("sends the name from the start form only when the Name field is filled", async () => {
    const pipelines = [{ id: "default", source: "built-in" }];
    const { root, sent } = await mount([], pipelines);
    const input = root.querySelector("input") as HTMLInputElement;
    const brief = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(input.maxLength).toBe(80);
    expect(input.placeholder).toBe("Short name of this slice");

    const fill = (element: HTMLElement, value: string) =>
      act(async () => {
        const proto = element instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const submit = () =>
      act(async () => {
        root.querySelector("form")?.requestSubmit();
      });

    await fill(brief, "Do it");
    await submit();
    await fill(input, "  push_line tool ");
    await submit();
    await fill(input, "   ");
    await submit();

    const path = "pipelines/workspaces/W1/runs";
    expect(sent.map((request) => request.body)).toEqual([
      { pipeline: "default", brief: "Do it" },
      { pipeline: "default", brief: "Do it", name: "push_line tool" },
      { pipeline: "default", brief: "Do it" },
    ]);
    expect(sent[0]?.path).toBe(path);
  });

  it("keeps the log in a closed block in the Gates row, and the failed tests in the notice", async () => {
    const failed = run({
      state: "failed",
      stageIndex: 2,
      message: [
        "gate test failed",
        "1 test failed:",
        "src/a.test.ts > adds",
        "",
        GATE_LOG_HEADING,
        "RAW LOG LINE",
      ].join("\n"),
      turns: [TASK, REVIEW],
    });
    const { root } = await mount([failed]);

    const notice = root.querySelector('[role="alert"]');
    expect(notice?.textContent).toContain("gate test failed");
    expect(notice?.textContent).toContain("src/a.test.ts > adds");
    expect(notice?.textContent).not.toContain("RAW LOG LINE");
    const log = rows(root)[2]?.closest("li")?.querySelector("details");
    expect(log?.open).toBe(false);
    expect(log?.textContent).toContain("RAW LOG LINE");
  });

  it("keeps a row the user opened open when new data arrives", async () => {
    const before = run({ turns: [TASK, REVIEW], stageIndex: 1 });
    const { root, send } = await mount([before]);
    expect(expanded(root)).toEqual(["false", "true"]);

    await act(async () => (rows(root)[0] as HTMLElement).click());
    expect(expanded(root)).toEqual(["true", "true"]);

    const more = turn({ id: "t-fix", kind: "fix", stageIndex: 1, createdAt: 13 * MIN });
    await send([{ ...before, turns: [TASK, REVIEW, more] }]);
    expect(expanded(root)).toEqual(["true", "false", "true"]);
  });
});
