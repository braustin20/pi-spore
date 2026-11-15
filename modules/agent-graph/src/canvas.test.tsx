// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { GraphAgent, GraphGroup, GraphStep, GraphTree } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { layoutGraph } from "./layout.js";
import { agentGraphWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (
  agentId: string,
  workspaceId: string,
  extra: Partial<GraphAgent> = {},
): GraphAgent => ({
  agentId,
  workspaceId,
  kind: "stage",
  role: "worker",
  status: "busy",
  model: "anthropic/claude-sonnet-5-5",
  since: 0,
  helpers: [],
  ...extra,
});

const step = (id: string, extra: Partial<GraphStep>): GraphStep => ({
  id,
  stage: "implement",
  kind: "task",
  state: "done",
  ...extra,
});

const group = (pipelineRunId: string, workspaceId: string, steps: GraphStep[]): GraphGroup => ({
  pipelineRunId,
  workspaceId,
  name: `slice ${pipelineRunId}`,
  state: "running",
  stage: "review",
  live: true,
  steps,
});

/** A run tree in project p1 with two lanes, and a workspace tree in project p2. */
const runTree: GraphTree = {
  kind: "run",
  workspaceId: "W1",
  projectId: "p1",
  name: "agent graph",
  runId: "RUN1",
  root: agent("C1", "W1", { kind: "worker", role: "orchestrator", title: "Rollout" }),
  groups: [
    group("PR1", "L1", [
      step("T1", { agent: agent("S1", "L1", { status: "idle" }) }),
      step("T2", {
        kind: "review",
        stage: "review",
        round: 1,
        state: "running",
        agent: agent("S2", "L1", { role: "reviewer" }),
      }),
      step("PR1:2", { kind: "gates", stage: "gates", state: "waiting", gates: ["check", "test"] }),
    ]),
    group("PR2", "L2", [step("T3", { state: "running", agent: agent("S3", "L2") })]),
  ],
};

const workspaceTree: GraphTree = {
  kind: "workspace",
  workspaceId: "W2",
  projectId: "p2",
  name: "theme-picker-fix",
  root: agent("C2", "W2", { kind: "worker", role: "orchestrator", status: "idle" }),
  groups: [group("PR3", "W2", [step("T4", { agent: agent("S4", "W2", { status: "idle" }) })])],
};

/** The landing component the module gives the workspaces view. */
function landing(): ComponentType<{ projectId?: string | undefined }> {
  let component: ComponentType<{ projectId?: string | undefined }> | undefined;
  agentGraphWeb.setup({
    use: () => ({
      setLanding: (given: ComponentType<{ projectId?: string | undefined }>) => {
        component = given;
      },
    }),
  } as unknown as WebHost);
  if (!component) throw new Error("the agent graph did not set the workspaces landing page");
  return component;
}

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

/** Renders the landing with a fake api; `send` pushes a topic event, as the server does. */
async function render(trees: GraphTree[], projectId?: string) {
  const Landing = landing();
  let push: ((event: unknown) => void) | undefined;
  const topics: string[] = [];
  const api = {
    get: async () => {
      throw new Error("the graph must not GET");
    },
    subscribe: (topic: string, onEvent: (event: unknown) => void) => {
      topics.push(topic);
      push = onEvent;
      onEvent({ type: "graph", trees });
      return () => {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  container.style.width = "1440px";
  container.style.height = "900px";
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Landing projectId={projectId} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const scope = container;
  return {
    scope,
    topics,
    send: async (next: GraphTree[]) => {
      await act(async () => push?.({ type: "graph", trees: next }));
    },
  };
}

const podLinks = (scope: Element) =>
  [...scope.querySelectorAll<HTMLAnchorElement>('a[href*="/chats/"]')].map((link) =>
    link.getAttribute("href"),
  );

describe("the agent graph canvas", () => {
  it("draws one pod per agent node, from the topic", async () => {
    const { scope, topics } = await render([runTree, workspaceTree]);
    expect(topics).toEqual(["agent-graph:trees"]);
    // Two roots, plus the steps: 4 steps with an agent; the gates step has no agent and no link.
    expect(podLinks(scope)).toHaveLength(6);
    expect(scope.querySelectorAll("[data-pod]")).toHaveLength(7);
    expect(scope.textContent).toContain("agent graph");
    expect(scope.textContent).toContain("slice PR1");
    expect(scope.textContent).toContain("check · test");
    expect(scope.textContent).toContain("working · sonnet 5.5");
  });

  it("links each pod to its chat, and not as a native drag", async () => {
    const { scope } = await render([runTree]);
    expect(podLinks(scope)).toContain("#/workspaces/L1/chats/S2");
    expect(podLinks(scope)).toContain("#/workspaces/W1/chats/C1");
    const link = scope.querySelector('a[href="#/workspaces/L1/chats/S2"]');
    expect(link?.getAttribute("draggable")).toBe("false");
  });

  it("drops a tree that a later event leaves out", async () => {
    const { scope, send } = await render([runTree, workspaceTree]);
    expect(podLinks(scope)).toContain("#/workspaces/W2/chats/C2");
    await send([runTree]);
    expect(podLinks(scope)).not.toContain("#/workspaces/W2/chats/C2");
    expect(podLinks(scope)).not.toContain("#/workspaces/W2/chats/S4");
    expect(scope.textContent).not.toContain("theme-picker-fix");
    expect(podLinks(scope)).toContain("#/workspaces/W1/chats/C1");
  });

  it("shows only the route's project", async () => {
    const { scope } = await render([runTree, workspaceTree], "p1");
    expect(podLinks(scope)).toContain("#/workspaces/W1/chats/C1");
    expect(podLinks(scope)).not.toContain("#/workspaces/W2/chats/C2");
  });

  it("says when no agent works, with a link to a new workspace", async () => {
    const all = await render([]);
    expect(all.scope.textContent).toContain("No agents work now.");
    expect(all.scope.querySelector('a[href="#/workspaces/new"]')).not.toBeNull();

    const one = await render([workspaceTree], "p1");
    expect(one.scope.textContent).toContain("No agents work now.");
    expect(one.scope.querySelector('a[href="#/workspaces/new/in/p1"]')).not.toBeNull();
  });
});

describe("the graph layout", () => {
  const trees = [runTree, workspaceTree, { ...workspaceTree, workspaceId: "W3" }];
  const boxes = (phone: boolean) =>
    layoutGraph(trees, phone)
      .nodes.filter((node) => node.type === "tree")
      .map((node) => ({ ...node.position, width: node.width ?? 0, height: node.height ?? 0 }));

  it("puts trees side by side on a desktop, without overlap", () => {
    const placed = boxes(false);
    expect(placed).toHaveLength(3);
    for (let i = 1; i < placed.length; i++) {
      const [before, after] = [placed[i - 1], placed[i]];
      expect(after?.x).toBeGreaterThanOrEqual((before?.x ?? 0) + (before?.width ?? 0));
      expect(after?.y).toBe(before?.y);
    }
  });

  it("stacks trees on a phone", () => {
    const placed = boxes(true);
    expect(placed).toHaveLength(3);
    for (let i = 1; i < placed.length; i++) {
      const [before, after] = [placed[i - 1], placed[i]];
      expect(after?.y).toBeGreaterThanOrEqual((before?.y ?? 0) + (before?.height ?? 0));
      expect(after?.x).toBe(before?.x);
    }
  });
});
