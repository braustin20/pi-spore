// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Lane, Run, Workspace } from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { runsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lane = (mergeStep?: string): Lane => ({
  id: "L1",
  runId: "U1",
  name: "feature",
  wave: 1,
  dependsOn: [],
  brief: "briefs/feature.md",
  pipeline: "light",
  state: "merging",
  ...(mergeStep === undefined ? {} : { mergeStep }),
  createdAt: 0,
});

const run = (shown: Lane): Run => ({
  id: "U1",
  projectId: "P1",
  workspaceId: "W9",
  line: "run/big-feature",
  base: "main",
  gates: ["check"],
  state: "running",
  coordinatorAgentId: "A0",
  createdAt: 0,
  lanes: [shown],
  questions: [],
});

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
  const api = {
    send: async () => ({}),
    subscribe: (_topic: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: "runs", runs: [shown] });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  const root = container;
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <Panel workspace={{ id: "W9" } as Workspace} />
      </ApiContext>,
    );
  });
  return root;
}

describe("a merging lane", () => {
  it("names the merge step in its chip", async () => {
    const root = await render(run(lane("gate test")));
    expect(root.textContent).toContain("Merging: gate test");
  });

  it("says Merging alone before the first step", async () => {
    const root = await render(run(lane()));
    expect(root.textContent).toContain("Merging");
    expect(root.textContent).not.toContain("Merging:");
  });
});
