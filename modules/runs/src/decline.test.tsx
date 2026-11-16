// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Lane, LaneState, Run, RunState, Workspace } from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { runsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (state: RunState, lanes: Lane[]): Run => ({
  id: "U1",
  projectId: "P1",
  workspaceId: "W9",
  line: "run/big-feature",
  base: "main",
  gates: ["check"],
  state,
  coordinatorAgentId: "A0",
  createdAt: 0,
  lanes,
  questions: [],
});

const lane = (id: string, name: string, state: LaneState, message?: string): Lane => ({
  id,
  runId: "U1",
  name,
  wave: 1,
  dependsOn: [],
  brief: `briefs/${name}.md`,
  pipeline: "light",
  state,
  ...(message === undefined ? {} : { message }),
  createdAt: 0,
});

const workspace = { id: "W9" } as Workspace;

const NoNote = () => null;

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

/** Render the run panel with one run. `refuse` makes every send fail with that message. */
async function render(shown: Run, refuse?: string) {
  let panel: ComponentType<{ workspace: Workspace }> | undefined;
  const view = { addPanel: (added: { component: typeof panel }) => (panel = added.component) };
  runsWeb.setup({
    use: () => ({ ...view, addApprovalView: () => {}, DeclineNote: NoNote }),
    addPage: () => {},
  } as unknown as WebHost);
  if (!panel) throw new Error("the runs module did not add its panel");
  const Panel = panel;
  const sent: { method: string; path: string; body: unknown }[] = [];
  let publishEvent: ((event: unknown) => void) | undefined;
  const api = {
    send: async (method: string, path: string, body: unknown) => {
      if (refuse) throw new Error(refuse);
      sent.push({ method, path, body });
      return {};
    },
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "runs", runs: [shown] });
      publishEvent = onEvent;
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  const root = container;
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <Panel workspace={workspace} />
      </ApiContext>,
    );
  });
  const button = (name: string) =>
    [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === name);
  const click = async (name: string) => {
    const found = button(name);
    if (!found) throw new Error(`no button ${name}`);
    await act(async () => found.click());
  };
  const type = async (text: string) => {
    const field = root.querySelector("textarea");
    if (!field) throw new Error("no textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        field,
        text,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  /** Send another `runs:list` snapshot, as the topic does when the run or a lane changes. */
  const publish = async (next: Run) => {
    await act(async () => publishEvent?.({ type: "runs", runs: [next] }));
  };
  return { root, sent, button, click, type, publish };
}

describe("declining a lane", () => {
  it("asks first, then posts the decline with the trimmed reason", async () => {
    const { root, sent, button, click, type } = await render(
      run("running", [lane("L1", "feature", "failed")]),
    );
    await click("Decline");
    expect(root.textContent).toContain('Decline lane "feature"?');
    expect(root.textContent).toContain("Nothing is deleted");
    expect(root.textContent).toContain("The coordinator is told");
    expect(sent).toEqual([]);
    await type("  redone in lane two  ");
    await click("Decline lane");
    expect(sent).toEqual([
      {
        method: "POST",
        path: "runs/U1/lanes/L1/decline",
        body: { reason: "redone in lane two" },
      },
    ]);
    // The confirm closes, so the reason goes with it.
    expect(button("Decline lane")).toBeUndefined();
  });

  it("will not decline without a reason", async () => {
    const { sent, button, click, type } = await render(
      run("running", [lane("L1", "feature", "failed")]),
    );
    await click("Decline");
    expect(button("Decline lane")?.disabled).toBe(true);
    await type("   ");
    expect(button("Decline lane")?.disabled).toBe(true);
    await type("dropped it");
    expect(button("Decline lane")?.disabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it("keeps the lane when the user backs out", async () => {
    const { root, sent, button, click } = await render(
      run("running", [lane("L1", "feature", "passed")]),
    );
    await click("Decline");
    await click("Keep lane");
    expect(root.querySelector("textarea")).toBeNull();
    expect(button("Decline")).toBeDefined();
    expect(sent).toEqual([]);
  });

  it("shows the refusal", async () => {
    const { root, click, type } = await render(
      run("running", [lane("L1", "feature", "failed")]),
      "Lane L1 is running; only a waiting, passed, or failed lane can be declined",
    );
    await click("Decline");
    await type("try anyway");
    await click("Decline lane");
    expect(root.textContent).toContain("only a waiting, passed, or failed lane can be declined");
  });

  it("closes the confirmation when the lane stops being declinable", async () => {
    const { root, button, click, publish } = await render(
      run("running", [lane("L1", "feature", "waiting")]),
    );
    await click("Decline");
    expect(root.querySelector("textarea")).not.toBeNull();
    await publish(run("running", [lane("L1", "feature", "starting")]));
    expect(root.textContent).toContain("Starting");
    expect(root.querySelector("textarea")).toBeNull();
    expect(button("Decline lane")).toBeUndefined();
    expect(button("Keep lane")).toBeUndefined();
    expect(button("Decline")).toBeUndefined();
  });

  it("closes the confirmation when the run is cancelled", async () => {
    const { root, button, click, publish, type } = await render(
      run("running", [lane("L1", "feature", "failed")]),
    );
    await click("Decline");
    await type("dropped it");
    await publish(run("cancelled", [lane("L1", "feature", "failed")]));
    expect(root.textContent).toContain("Cancelled");
    expect(root.querySelector("textarea")).toBeNull();
    expect(button("Decline lane")).toBeUndefined();
    expect(button("Keep lane")).toBeUndefined();
  });

  it("offers Decline on a waiting, passed, or failed lane of a running or finished run", async () => {
    for (const [runState, laneState] of [
      ["running", "waiting"],
      ["running", "passed"],
      ["running", "failed"],
      ["finished", "failed"],
    ] as const) {
      const { button } = await render(run(runState, [lane("L1", "feature", laneState)]));
      expect(button("Decline"), `${runState} run, ${laneState} lane`).toBeDefined();
    }
  });

  it("offers no Decline on a lane that is asked about, at work, merging, or over", async () => {
    for (const laneState of [
      "approval",
      "starting",
      "running",
      "declined",
      "merging",
      "merged",
      "cancelled",
    ] as const) {
      const { root, button } = await render(run("running", [lane("L1", "feature", laneState)]));
      expect(button("Decline"), `${laneState} lane`).toBeUndefined();
      root.remove();
    }
  });

  it("offers no Decline in a cancelled run", async () => {
    for (const laneState of ["waiting", "passed", "failed"] as const) {
      const { root, button } = await render(run("cancelled", [lane("L1", "feature", laneState)]));
      expect(button("Decline"), `${laneState} lane`).toBeUndefined();
      root.remove();
    }
  });

  it("shows a declined lane with its chip and its reason", async () => {
    const { root, button } = await render(
      run("running", [lane("L1", "feature", "declined", "the coordinator redid this")]),
    );
    expect(root.textContent).toContain("Declined");
    expect(root.textContent).toContain("the coordinator redid this");
    expect(button("Decline")).toBeUndefined();
  });
});
