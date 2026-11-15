// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { GraphAgent, GraphGroup, GraphStep, GraphTree } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
function unmount() {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
}
afterEach(unmount);

/** Renders the landing with a fake api; `send` pushes a topic event, as the server does. */
async function render(trees: GraphTree[], projectId?: string) {
  // One landing at a time, as the workspaces view shows it.
  unmount();
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

/**
 * Drags `element` by (dx, dy) with the mouse, as d3-drag inside React Flow reads it. happy-dom has no layout, so
 * every box is 0 by 0 and the pointer always looks past the canvas edge, which starts React Flow's auto-pan loop.
 * A canvas-sized box keeps the pointer inside, as in a browser.
 */
async function drag(element: Element | null, dx: number, dy: number) {
  if (!element) throw new Error("nothing to drag");
  const box = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 1440, 900));
  const at = (x: number, y: number) => ({ bubbles: true, clientX: x, clientY: y, view: window });
  try {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("mousedown", at(400, 400)));
      window.dispatchEvent(new MouseEvent("mousemove", at(400 + dx / 2, 400 + dy / 2)));
      window.dispatchEvent(new MouseEvent("mousemove", at(400 + dx, 400 + dy)));
      window.dispatchEvent(new MouseEvent("mouseup", at(400 + dx, 400 + dy)));
    });
  } finally {
    box.mockRestore();
  }
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

  it("labels each root by its agent", async () => {
    const planner: GraphTree = {
      ...workspaceTree,
      workspaceId: "W9",
      root: agent("C9", "W9", { kind: "worker", role: "planner" }),
      groups: [],
    };
    const { scope } = await render([runTree, workspaceTree, planner]);
    const roleOf = (href: string) =>
      scope.querySelector(`a[href="${href}"] .ag-role`)?.textContent ?? `no pod for ${href}`;
    expect(roleOf("#/workspaces/W1/chats/C1")).toBe("coordinator");
    expect(roleOf("#/workspaces/W2/chats/C2")).toBe("worker chat");
    expect(roleOf("#/workspaces/W9/chats/C9")).toBe("planner");
  });

  it("keeps a dragged pod where it was put after the page comes back, until a reload", async () => {
    const first = await render([runTree]);
    const node = () =>
      container?.querySelector<HTMLElement>('.react-flow__node[data-id="step:T3"]') ?? null;
    const before = node()?.style.transform;
    expect(before).toMatch(/translate/);
    await drag(node(), 40, 30);
    const moved = node()?.style.transform;
    expect(moved).not.toBe(before);

    // A later event keeps it.
    await first.send([runTree]);
    expect(node()?.style.transform).toBe(moved);

    // The workspaces view unmounts the landing while a chat is open, and mounts it again on the way back.
    unmount();
    expect(document.querySelector(".react-flow")).toBeNull();
    await render([runTree]);
    expect(node()?.style.transform).toBe(moved);
  });

  it("shows a running fix as the working step, and the implement and review it answers as done", async () => {
    // The task step and its fix share one worker agent, busy during the fix; the group's stage still says review.
    const worker = agent("S5", "W5", { title: "Cut the extra schema" });
    const fixing: GraphTree = {
      ...workspaceTree,
      workspaceId: "W5",
      projectId: "p1",
      root: agent("C5", "W5", { kind: "worker", role: "orchestrator" }),
      groups: [
        group("PR5", "W5", [
          step("T5", { agent: worker }),
          step("T6", {
            kind: "review",
            stage: "review",
            round: 1,
            agent: agent("S6", "W5", { role: "reviewer", status: "idle" }),
          }),
          step("T7", { kind: "fix", stage: "review", round: 1, state: "running", agent: worker }),
        ]),
      ],
    };
    const { scope } = await render([fixing]);
    const pod = (id: string) =>
      scope.querySelector(`.react-flow__node[data-id="step:${id}"] [data-pod]`);
    expect(pod("T5")?.classList).toContain("s-idle");
    expect(pod("T6")?.classList).toContain("s-idle");
    expect(pod("T7")?.classList).toContain("s-work");
    expect(pod("T7")?.querySelector(".ag-role")?.textContent).toBe("fix r1");
    expect(pod("T7")?.getAttribute("href")).toBe("#/workspaces/W5/chats/S5");
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
