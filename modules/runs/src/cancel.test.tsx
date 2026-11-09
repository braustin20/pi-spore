// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Run, Workspace } from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { runsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (state: Run["state"]): Run => ({
  id: "U1",
  projectId: "P1",
  workspaceId: "W9",
  line: "run/big-feature",
  base: "main",
  gates: ["check"],
  state,
  coordinatorAgentId: "A0",
  createdAt: 0,
  lanes: [],
  questions: [],
});

const workspace = { id: "W9" } as Workspace;

const NoNote = () => null;

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

async function render(shown: Run) {
  let panel: ComponentType<{ workspace: Workspace }> | undefined;
  const view = { addPanel: (added: { component: typeof panel }) => (panel = added.component) };
  runsWeb.setup({
    use: () => ({ ...view, addApprovalView: () => {}, DeclineNote: NoNote }),
    addPage: () => {},
  } as unknown as WebHost);
  if (!panel) throw new Error("the runs module did not add its panel");
  const Panel = panel;
  const sent: { method: string; path: string }[] = [];
  const api = {
    send: async (method: string, path: string) => {
      sent.push({ method, path });
      return {};
    },
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "runs", runs: [shown] });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <Panel workspace={workspace} />
      </ApiContext>,
    );
  });
  const root = container;
  const button = (name: string) =>
    [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === name);
  const click = async (name: string) => {
    await act(async () => button(name)?.click());
  };
  return { root, sent, button, click };
}

describe("cancelling a run", () => {
  it("asks first, then posts the cancel", async () => {
    const { root, sent, button, click } = await render(run("running"));
    expect(root.textContent).toContain("Running");
    expect(button("Cancel run")).toBeUndefined();
    await click("Cancel");
    expect(root.textContent).toContain("Nothing is deleted");
    expect(sent).toEqual([]);
    await click("Cancel run");
    expect(sent).toEqual([{ method: "POST", path: "runs/U1/cancel" }]);
  });

  it("keeps the run when the user keeps it running", async () => {
    const { root, sent, click } = await render(run("running"));
    await click("Cancel");
    await click("Keep running");
    expect(root.textContent).not.toContain("Nothing is deleted");
    expect(sent).toEqual([]);
  });

  it("offers no Cancel once the run is cancelled or finished", async () => {
    for (const [state, text] of [
      ["cancelled", "Cancelled"],
      ["finished", "PR opened"],
    ] as const) {
      const { root, button } = await render(run(state));
      expect(root.textContent).toContain(text);
      expect(button("Cancel")).toBeUndefined();
      root.remove();
    }
  });
});

describe("a blocked lane", () => {
  it("shows Blocked and the error, and Retry posts the retry of its pipeline run", async () => {
    const blocked: Run = {
      ...run("running"),
      lanes: [
        {
          id: "L1",
          runId: "U1",
          name: "feature",
          wave: 1,
          dependsOn: [],
          brief: "briefs/feature.md",
          pipeline: "gated",
          state: "running",
          workspaceId: "W1",
          pipelineRunId: "R1",
          blocked: 'stage "gates": no action "check"',
          createdAt: 0,
        },
      ],
    };
    const { root, sent, click } = await render(blocked);
    expect(root.textContent).toContain("Blocked");
    expect(root.textContent).toContain('stage "gates": no action "check"');
    await click("Retry");
    expect(sent).toEqual([{ method: "POST", path: "pipelines/runs/R1/retry" }]);
  });
});
