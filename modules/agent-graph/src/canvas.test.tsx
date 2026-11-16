// @vitest-environment happy-dom
import type { UserWait } from "@pi-spore/mod-agents/web";
import type { LandingButton } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { GraphAgent, GraphGroup, GraphHelper, GraphStep, GraphTree } from "@pi-spore/shared";
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
  positions: {},
};

const workspaceTree: GraphTree = {
  kind: "workspace",
  workspaceId: "W2",
  projectId: "p2",
  name: "theme-picker-fix",
  root: agent("C2", "W2", { kind: "worker", role: "orchestrator", status: "idle" }),
  groups: [group("PR3", "W2", [step("T4", { agent: agent("S4", "W2", { status: "idle" }) })])],
  positions: {},
};

/** The chats that wait for the user, as the agents web module tells them; `render` sets them. */
let userWaits: ReadonlyMap<string, UserWait> = new Map();

/** The landing component the module gives the workspaces view. */
function landing(): ComponentType<{ projectId?: string | undefined }> {
  let component: ComponentType<{ projectId?: string | undefined }> | undefined;
  agentGraphWeb.setup({
    use: (key: { owner: string }) =>
      key.owner === "agents"
        ? { useUserWaits: () => userWaits }
        : {
            setLanding: (
              given: ComponentType<{ projectId?: string | undefined }>,
              _button: LandingButton,
            ) => {
              component = given;
            },
          },
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
async function render(trees: GraphTree[], projectId?: string, waits: [string, UserWait][] = []) {
  // One landing at a time, as the workspaces view shows it.
  unmount();
  userWaits = new Map(waits);
  const Landing = landing();
  let push: ((event: unknown) => void) | undefined;
  const topics: string[] = [];
  const sent: [string, string, unknown][] = [];
  let fail: Error | undefined;
  const api = {
    get: async () => {
      throw new Error("the graph must not GET");
    },
    send: async (method: string, path: string, body?: unknown) => {
      sent.push([method, path, body]);
      if (fail) throw fail;
      return { ok: true };
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
  const show = async (project: string | undefined) => {
    await act(async () => {
      root?.render(
        <ApiContext value={api}>
          <TooltipProvider>
            <Landing projectId={project} />
          </TooltipProvider>
        </ApiContext>,
      );
    });
  };
  await show(projectId);
  const scope = container;
  return {
    scope,
    topics,
    /** Every `api.send` call, as `[method, path, body]`. */
    sent,
    /** Makes every later `api.send` reject with `error`, or resolve again with `undefined`. */
    failWith: (error: Error | undefined) => {
      fail = error;
    },
    /** Changes the route's project, as the workspaces view does, without a new mount. */
    show,
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

const nodeOf = (id: string) =>
  container?.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`) ?? null;
const transformOf = (id: string) => nodeOf(id)?.style.transform;
/** The x and y of a `translate(Xpx, Ypx)` transform. */
const translation = (transform: string | undefined) =>
  (transform?.match(/-?[\d.]+/g) ?? []).map(Number);
const button = (scope: Element, name: string) =>
  [...scope.querySelectorAll("button")].find((each) => each.textContent === name) ?? null;
async function click(element: Element | null) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
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

  it("keeps a dragged pod where it was put after the page comes back, from the saved places", async () => {
    const first = await render([runTree]);
    const before = transformOf("step:T3");
    expect(before).toMatch(/translate/);
    await drag(nodeOf("step:T3"), 40, 30);
    const moved = transformOf("step:T3");
    expect(moved).not.toBe(before);

    // A later event keeps it, before the server echoes the saved place.
    await first.send([runTree]);
    expect(transformOf("step:T3")).toBe(moved);

    // The workspaces view unmounts the landing while a chat is open, and mounts it again on the way back. The
    // snapshot then holds the place the drag saved.
    const [, , body] = first.sent[0] ?? [];
    const { x, y } = body as { x: number; y: number };
    unmount();
    expect(document.querySelector(".react-flow")).toBeNull();
    await render([{ ...runTree, positions: { "step:T3": { x, y } } }]);
    expect(transformOf("step:T3")).toBe(moved);
  });

  it("saves a drag with one PUT when it ends, at the place it draws", async () => {
    const { sent } = await render([runTree]);
    const auto = layoutGraph([runTree], new Map(), false).nodes.find((n) => n.id === "step:T3");
    const [x0 = 0, y0 = 0] = translation(transformOf("step:T3"));
    await drag(nodeOf("step:T3"), 40, 30);
    const [x1 = 0, y1 = 0] = translation(transformOf("step:T3"));
    expect([x1 - x0, y1 - y0]).not.toEqual([0, 0]);
    expect(sent).toEqual([
      [
        "PUT",
        "agent-graph/positions",
        {
          node: "step:T3",
          x: (auto?.position.x ?? 0) + x1 - x0,
          y: (auto?.position.y ?? 0) + y1 - y0,
        },
      ],
    ]);
  });

  it("does not save a click without a drag", async () => {
    const { sent } = await render([runTree]);
    await drag(nodeOf("step:T3"), 0, 0);
    expect(sent).toEqual([]);
  });

  it("draws a tree at its saved place", async () => {
    await render([{ ...runTree, positions: { "tree:W1": { x: 500, y: 300 } } }]);
    expect(transformOf("tree:W1")).toBe("translate(500px,300px)");
  });

  it("draws a step at its saved place, relative to its group", async () => {
    await render([runTree]);
    const auto = layoutGraph([runTree], new Map(), false).nodes.find((n) => n.id === "step:T3");
    const [autoX = 0, autoY = 0] = translation(transformOf("step:T3"));
    await render([{ ...runTree, positions: { "step:T3": { x: 5, y: 7 } } }]);
    // The group's absolute place, plus the saved place.
    expect(translation(transformOf("step:T3"))).toEqual([
      autoX - (auto?.position.x ?? 0) + 5,
      autoY - (auto?.position.y ?? 0) + 7,
    ]);
  });

  it("puts every node back at its automatic place on Reset layout", async () => {
    const { scope, sent } = await render([runTree]);
    const before = transformOf("step:T3");
    await drag(nodeOf("step:T3"), 40, 30);
    expect(transformOf("step:T3")).not.toBe(before);
    sent.length = 0;
    await click(button(scope, "Reset layout"));
    expect(sent).toEqual([["DELETE", "agent-graph/positions", undefined]]);
    expect(transformOf("step:T3")).toBe(before);
  });

  it("shows why a save failed, until the next one works", async () => {
    const { scope, failWith } = await render([runTree]);
    failWith(new Error("the graph changed"));
    await drag(nodeOf("step:T3"), 40, 30);
    expect(scope.textContent).toContain("the graph changed");
    failWith(undefined);
    await drag(nodeOf("step:T3"), 10, 10);
    expect(scope.textContent).not.toContain("the graph changed");
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

  it("says approved on an approved review step, with an ok ring", async () => {
    const { scope } = await render([
      {
        ...workspaceTree,
        groups: [
          group("PR8", "W2", [
            step("R8", {
              kind: "review",
              stage: "review",
              round: 1,
              outcome: "approved",
              agent: agent("S8", "W2", { role: "reviewer", status: "idle" }),
            }),
          ]),
        ],
      },
    ]);
    const pod = scope.querySelector('.react-flow__node[data-id="step:R8"] [data-pod]');

    expect(pod?.querySelector(".ag-meta")?.textContent).toBe("approved · sonnet 5.5");
    expect(pod?.classList).toContain("o-ok");
  });

  it("counts a revising review step's findings in its meta, with a warn ring", async () => {
    const { scope } = await render([
      {
        ...workspaceTree,
        groups: [
          group("PR9", "W2", [
            step("R9", {
              kind: "review",
              stage: "review",
              round: 1,
              outcome: "revise",
              findings: 2,
              agent: agent("S9", "W2", { role: "reviewer", status: "idle" }),
            }),
            step("R10", {
              kind: "review",
              stage: "review",
              round: 2,
              outcome: "revise",
              findings: 1,
              agent: agent("S10", "W2", { role: "reviewer", status: "idle" }),
            }),
          ]),
        ],
      },
    ]);
    const meta = (id: string) =>
      scope.querySelector(`.react-flow__node[data-id="step:${id}"] .ag-meta`)?.textContent;

    expect(meta("R9")).toBe("revise · 2 findings · sonnet 5.5");
    expect(meta("R10")).toBe("revise · 1 finding · sonnet 5.5");
    expect(
      scope.querySelector('.react-flow__node[data-id="step:R9"] [data-pod]')?.classList,
    ).toContain("o-warn");
  });

  it("says why a blocked step waits in its pod's hover title, keeping its heading", async () => {
    const note =
      'stage review: the reviewer agent "Review 1" failed. Retry starts a fresh reviewer.';
    const { scope } = await render([
      {
        ...workspaceTree,
        workspaceId: "W11",
        groups: [
          group("PR11", "W11", [
            step("B11", {
              kind: "review",
              stage: "review",
              round: 1,
              state: "running",
              outcome: "blocked",
              note,
              agent: agent("S11", "W11", { role: "reviewer", title: "Review 1" }),
            }),
            step("B12", {
              kind: "review",
              stage: "review",
              round: 1,
              outcome: "approved",
              agent: agent("S12", "W11", { role: "reviewer", status: "idle", title: "Review 2" }),
            }),
            step("B13", {
              kind: "gates",
              stage: "gates",
              state: "running",
              outcome: "blocked",
              note,
            }),
          ]),
        ],
      },
    ]);
    const pod = (id: string) =>
      scope.querySelector(`.react-flow__node[data-id="step:${id}"] [data-pod]`);

    // The reason is a hover line under the pod's own title, so the heading stays and nothing clips.
    expect(pod("B11")?.getAttribute("title")).toBe(`Review 1\n${note}`);
    expect(pod("B11")?.querySelector(".ag-title")?.textContent).toBe("Review 1");
    // A step that waits for nobody has no hover text, as before.
    expect(pod("B12")?.hasAttribute("title")).toBe(false);
    // A step with no heading of its own says only why it waits.
    expect(pod("B13")?.getAttribute("title")).toBe(note);
  });

  it("names a gates step's round, like a review step's", async () => {
    const gates: GraphTree = {
      ...workspaceTree,
      groups: [
        group("PR3", "W2", [
          step("G0", { kind: "gates", stage: "gates" }),
          step("G2", { kind: "gates", stage: "gates", round: 2, state: "running" }),
        ]),
      ],
    };
    const { scope } = await render([gates]);
    const role = (id: string) =>
      scope.querySelector(`.react-flow__node[data-id="step:${id}"] .ag-role`)?.textContent;
    expect(role("G0")).toBe("gates");
    expect(role("G2")).toBe("gates r2");
  });

  it("marks a lane's group that the run merges, with the merge step", async () => {
    const ended = (pipelineRunId: string, merging: string): GraphGroup => ({
      ...group(pipelineRunId, "L1", [step(`${pipelineRunId}:0`, {})]),
      state: "passed",
      live: false,
      merging,
    });
    const { scope } = await render([
      {
        ...runTree,
        groups: [ended("PR1", "gate test"), ended("PR2", "merging")],
      },
    ]);
    const panel = (id: string) =>
      scope.querySelector(`.react-flow__node[data-id="group:${id}"] .ag-group`);
    expect(panel("PR1")?.classList).toContain("live");
    expect(panel("PR1")?.querySelector(".ag-group-merging")?.textContent).toBe(
      "merging: gate test",
    );
    expect(panel("PR2")?.querySelector(".ag-group-merging")?.textContent).toBe("merging");
  });

  describe("a chat that waits for the user", () => {
    const rootTree = (status: GraphAgent["status"]): GraphTree => ({
      ...workspaceTree,
      root: agent("C2", "W2", {
        kind: "worker",
        role: "orchestrator",
        status,
        model: "anthropic/claude-opus-5-5",
      }),
    });
    const pod = (scope: Element, href: string) => {
      const link = scope.querySelector(`a[href="${href}"]`);
      if (!link) throw new Error(`no pod for ${href}`);
      return { meta: link.querySelector(".ag-meta")?.textContent, classes: link.classList };
    };
    const root = "#/workspaces/W2/chats/C2";

    it("shows a stopped root with an open question as waiting for the user's answer", async () => {
      const { scope } = await render([rootTree("stopped")], undefined, [["C2", "question"]]);
      expect(pod(scope, root).meta).toBe("waiting for your answer · opus 5.5");
      expect(pod(scope, root).classes).toContain("s-wait");
    });

    it("shows an idle root with an approval as waiting", async () => {
      const { scope } = await render([rootTree("idle")], undefined, [["C2", "approval"]]);
      expect(pod(scope, root).classes).toContain("s-wait");
    });

    it("shows the same root without a wait as stopped, as before", async () => {
      const { scope } = await render([rootTree("stopped")]);
      expect(pod(scope, root).meta).toBe("stopped · opus 5.5");
      expect(pod(scope, root).classes).toContain("s-idle");
      expect(pod(scope, root).classes).not.toContain("s-wait");
    });

    it("shows a busy root with an old question as working", async () => {
      const { scope } = await render([rootTree("busy")], undefined, [["C2", "question"]]);
      expect(pod(scope, root).meta).toBe("working · opus 5.5");
      expect(pod(scope, root).classes).toContain("s-work");
    });

    it("shows a busy root with an open dialog as waiting, since the dialog blocks it", async () => {
      const { scope } = await render([rootTree("busy")], undefined, [["C2", "dialog"]]);
      expect(pod(scope, root).meta).toBe("waiting for your answer · opus 5.5");
      expect(pod(scope, root).classes).toContain("s-wait");
    });

    it("shows a running stage whose chat has a dialog open as waiting", async () => {
      const { scope } = await render([runTree], undefined, [["S3", "dialog"]]);
      const stage = pod(scope, "#/workspaces/L2/chats/S3");
      expect(stage.meta).toBe("waiting for your answer · sonnet 5.5");
      expect(stage.classes).toContain("s-wait");
    });

    it("does not show a wait on a done stage, whose agent may serve a later step", async () => {
      const { scope } = await render([runTree], undefined, [["S1", "dialog"]]);
      const stage = pod(scope, "#/workspaces/L1/chats/S1");
      expect(stage.meta).toBe("idle · sonnet 5.5");
      expect(stage.classes).not.toContain("s-wait");
    });

    it("names the wait in the legend", async () => {
      const { scope } = await render([runTree]);
      expect(scope.querySelector(".ag-legend")?.textContent).toContain("waits for you");
    });
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
    layoutGraph(trees, new Map(), phone)
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

  it("draws a merging lane's group as live, with a live thread from the root", () => {
    const merging: GraphTree = {
      ...runTree,
      root: { ...runTree.root, status: "idle" },
      groups: [
        {
          ...group("PR1", "L1", [step("T1", { agent: agent("S1", "L1", { status: "idle" }) })]),
          state: "passed",
          live: false,
          merging: "gate test",
        },
      ],
    };
    const { nodes, edges } = layoutGraph([merging], new Map(), false);
    expect(nodes.find((node) => node.type === "tree")?.data).toMatchObject({ live: true });
    expect(edges.find((edge) => edge.id === "thread:step:T1")?.data).toMatchObject({
      tone: "coord",
      live: true,
      dim: false,
    });
  });

  it("moves a merging lane's steps down, so its merging line does not cover the first step", () => {
    const lane = group("PR1", "L1", [step("T1", {}), step("T2", { state: "waiting" })]);
    const placed = (merging?: string) => {
      const { nodes } = layoutGraph(
        [{ ...runTree, groups: [merging ? { ...lane, merging } : lane] }],
        new Map(),
        false,
      );
      const at = (id: string) => nodes.find((node) => node.id === id);
      return {
        first: at("step:T1")?.position.y ?? 0,
        second: at("step:T2")?.position.y ?? 0,
        height: at("group:PR1")?.height ?? 0,
      };
    };
    const plain = placed();
    const merging = placed("gate test");
    const shift = merging.first - plain.first;
    expect(shift).toBeGreaterThanOrEqual(16);
    expect(merging.second - plain.second).toBe(shift);
    expect(merging.height - plain.height).toBe(shift);
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

  /** The `default` pipeline's steps up to round 2, with the given states; members of a round have `beside`. */
  type Id = "I" | "R1" | "A1" | "G1" | "F1" | "R2" | "G2";
  const parallel = (
    states: Partial<Record<Id, GraphStep["state"]>>,
    phone = false,
    live = true,
  ) => {
    const all: [Id, Partial<GraphStep>][] = [
      ["I", {}],
      ["R1", { kind: "review", stage: "review", round: 1 }],
      ["A1", { kind: "review", stage: "adversarial", round: 1, beside: true }],
      ["G1", { kind: "gates", stage: "gates", round: 1, beside: true }],
      ["F1", { kind: "fix", round: 1 }],
      ["R2", { kind: "review", stage: "review", round: 2 }],
      ["G2", { kind: "gates", stage: "gates", round: 2, beside: true }],
    ];
    const steps = all.flatMap(([id, extra]) => {
      const state = states[id];
      return state ? [step(id, { ...extra, state })] : [];
    });
    const tree: GraphTree = {
      ...workspaceTree,
      groups: [{ ...group("PR3", "W2", steps), live }],
    };
    const { nodes, edges } = layoutGraph([tree], new Map(), phone);
    const at = (id: string) => nodes.find((node) => node.id === `step:${id}`)?.position;
    const edge = (id: string) => {
      const found = edges.find((each) => each.id === id);
      if (!found)
        throw new Error(`no edge ${id}; edges: ${edges.map((each) => each.id).join(", ")}`);
      return found;
    };
    return { at, edge, edges };
  };

  it("forks a step into a round's members, side by side, each with a live thread", () => {
    const { at, edge } = parallel({ I: "done", R1: "running", G1: "running" });
    for (const id of ["thread:step:R1", "thread:step:G1"]) {
      expect(edge(id).source).toBe("step:I");
      expect(edge(id).data?.live).toBe(true);
    }
    expect(at("G1")?.y).toBe(at("R1")?.y);
    expect(at("G1")?.x).not.toBe(at("R1")?.x);
  });

  it("keeps the route's color in a group that is not live, without making it live", () => {
    const { edge } = parallel({ I: "done", R1: "running", G1: "running" }, false, false);
    for (const id of ["thread:step:R1", "thread:step:G1"]) {
      expect(edge(id).data?.tone).toBe("chat");
      expect(edge(id).data?.live).toBe(false);
    }
  });

  it("joins a round's members into the fix after them, live only on the route", () => {
    const { edge } = parallel({
      I: "done",
      R1: "done",
      G1: "done",
      F1: "running",
      R2: "waiting",
      G2: "waiting",
    });
    expect(edge("thread:step:R1:step:F1").source).toBe("step:R1");
    expect(edge("thread:step:G1:step:F1").source).toBe("step:G1");
    expect(edge("thread:step:R1:step:F1").data?.live).toBe(true);
    expect(edge("thread:step:G1:step:F1").data?.live).toBe(false);
    expect(edge("thread:step:G2").data?.live).toBe(false);
    expect(edge("thread:step:G2").data?.dim).toBe(true);
  });

  it("in round 2, runs live threads to every running step through each round's first step", () => {
    const { edge } = parallel({
      I: "done",
      R1: "done",
      A1: "done",
      G1: "done",
      F1: "done",
      R2: "running",
      G2: "running",
    });
    expect(edge("thread:step:A1").data?.live).toBe(false);
    for (const id of [
      "thread:step:I",
      "thread:step:R1",
      "thread:step:R1:step:F1",
      "thread:step:R2",
      "thread:step:G2",
    ])
      expect(edge(id).data?.live).toBe(true);
    expect(edge("thread:step:A1:step:F1").data?.live).toBe(false);
    expect(edge("thread:step:G2").source).toBe("step:F1");
  });

  it("draws a chain without `beside` as one thread from each step to the next", () => {
    const { edges } = layoutGraph([runTree], new Map(), false);
    expect(edges.map((each) => [each.id, each.source, each.sourceHandle, each.data?.live])).toEqual(
      [
        ["thread:step:T1", "tree:W1", "root", true],
        ["thread:step:T2", "step:T1", "out", true],
        ["thread:step:PR1:2", "step:T2", "out", false],
        ["thread:step:T3", "tree:W1", "root", true],
      ],
    );
  });

  it("stacks a round's members on a phone, each with its thread from the step before the round", () => {
    const { at, edge } = parallel({ I: "done", R1: "running", G1: "running" }, true);
    expect(at("G1")?.y).not.toBe(at("R1")?.y);
    expect(edge("thread:step:R1").source).toBe("step:I");
    expect(edge("thread:step:G1").source).toBe("step:I");
  });
});

describe("helpers on the canvas", () => {
  const researcher: GraphHelper = {
    id: "H1",
    agent: "researcher",
    model: "anthropic/claude-sonnet-5-5",
    state: "running",
    currentTool: "read",
  };
  const scout: GraphHelper = {
    id: "H2",
    agent: "scout",
    model: "anthropic/claude-haiku-5-5",
    state: "running",
    currentTool: "bash",
  };
  /** The run tree with `rootHelpers` on its coordinator and `stepHelpers` on step T3's agent. */
  const withHelpers = (rootHelpers: GraphHelper[], stepHelpers: GraphHelper[]): GraphTree => ({
    ...runTree,
    root: { ...runTree.root, helpers: rootHelpers },
    groups: [
      runTree.groups[0] as GraphGroup,
      group("PR2", "L2", [
        step("T3", { state: "running", agent: agent("S3", "L2", { helpers: stepHelpers }) }),
      ]),
    ],
  });
  const helperEl = (scope: Element, id: string) =>
    scope.querySelector<HTMLElement>(`[data-helper="${id}"]`);
  const end = async (scope: Element, id: string) => {
    const spore = helperEl(scope, id)?.querySelector(".ag-spore");
    if (!spore) throw new Error(`no spore for helper ${id}`);
    await act(async () => {
      spore.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
  };

  it("draws a helper inside its parent's pod, with its name and short model", async () => {
    const { scope } = await render([withHelpers([researcher], [scout])]);
    const onRoot = helperEl(scope, "H1");
    expect(onRoot?.closest("a")?.getAttribute("href")).toBe("#/workspaces/W1/chats/C1");
    expect(onRoot?.closest("[data-pod]")?.classList).toContain("ag-root");
    expect(onRoot?.textContent).toContain("researcher");
    expect(onRoot?.textContent).toContain("sonnet 5.5");
    const onStep = helperEl(scope, "H2");
    expect(onStep?.closest("a")?.getAttribute("href")).toBe("#/workspaces/L2/chats/S3");
    expect(onStep?.closest(".react-flow__node")?.getAttribute("data-id")).toBe("step:T3");
    expect(onStep?.textContent).toContain("scout");
    expect(onStep?.textContent).toContain("haiku 5.5");
  });

  it("names the helper's current tool on hover", async () => {
    const { scope } = await render([withHelpers([researcher], [scout])]);
    expect(helperEl(scope, "H2")?.title).toBe("scout · bash");
    expect(helperEl(scope, "H1")?.title).toBe("researcher · read");
  });

  it("pops a helper that ends, then drops it", async () => {
    const { scope, send } = await render([withHelpers([researcher], [scout])]);
    await send([withHelpers([researcher], [{ ...scout, state: "done" }])]);
    expect(helperEl(scope, "H2")?.classList).toContain("pop");
    expect(helperEl(scope, "H2")?.classList).not.toContain("fail");
    expect(helperEl(scope, "H1")?.classList).not.toContain("pop");
    await end(scope, "H2");
    expect(helperEl(scope, "H2")).toBeNull();
    expect(helperEl(scope, "H1")).not.toBeNull();
  });

  it("pops a helper that fails in the fail color, then drops it", async () => {
    const { scope, send } = await render([withHelpers([researcher], [scout])]);
    await send([withHelpers([{ ...researcher, state: "failed" }], [scout])]);
    expect(helperEl(scope, "H1")?.classList).toContain("pop");
    expect(helperEl(scope, "H1")?.classList).toContain("fail");
    await end(scope, "H1");
    expect(helperEl(scope, "H1")).toBeNull();
  });

  it("pops a helper that leaves the list, then drops it", async () => {
    const { scope, send } = await render([withHelpers([researcher], [scout])]);
    await send([withHelpers([researcher], [])]);
    expect(helperEl(scope, "H2")?.classList).toContain("pop");
    expect(helperEl(scope, "H2")?.classList).not.toContain("fail");
    await end(scope, "H2");
    expect(helperEl(scope, "H2")).toBeNull();
  });

  it("keeps the rows of helpers that still pop, so the stage below waits to move up", async () => {
    const two = (helpers: GraphHelper[]): GraphTree => ({
      ...runTree,
      groups: [
        group("PR1", "L1", [
          step("T1", { state: "running", agent: agent("S1", "L1", { helpers }) }),
          step("T2", { kind: "review", stage: "review", round: 1, state: "waiting" }),
        ]),
      ],
    });
    const { scope, send } = await render([two([researcher, scout])]);
    const below = () =>
      scope.querySelector<HTMLElement>('.react-flow__node[data-id="step:T2"]')?.style.transform;
    const before = below();
    expect(before).toMatch(/translate/);
    await send([
      two([
        { ...researcher, state: "done" },
        { ...scout, state: "done" },
      ]),
    ]);
    // The server's next event leaves the ended helpers out.
    await send([two([])]);
    expect(helperEl(scope, "H1")?.classList).toContain("pop");
    expect(helperEl(scope, "H2")?.classList).toContain("pop");
    expect(below()).toBe(before);
    await end(scope, "H1");
    await end(scope, "H2");
    expect(below()).not.toBe(before);
  });

  it("buds a helper that comes with a new pod in a later event", async () => {
    const { scope, send } = await render([withHelpers([], [])]);
    const later: GraphTree = {
      ...withHelpers([], []),
      groups: [
        ...withHelpers([], []).groups,
        group("PR9", "L9", [
          step("T9", { state: "running", agent: agent("S9", "L9", { helpers: [scout] }) }),
        ]),
      ],
    };
    await send([later]);
    expect(helperEl(scope, "H2")?.closest(".react-flow__node")?.getAttribute("data-id")).toBe(
      "step:T9",
    );
    expect(helperEl(scope, "H2")?.classList).toContain("bud");
  });

  it("moves a running helper to the fix step of its agent, with no pop and no second copy", async () => {
    // The server puts a reused stage agent's helpers on its last node: a new fix step takes them over.
    const worker = (helpers: GraphHelper[]) => agent("S5", "L5", { helpers });
    const lane = (steps: GraphStep[]): GraphTree => ({
      ...runTree,
      groups: [group("PR5", "L5", steps)],
    });
    const { scope, send } = await render([
      lane([step("T5", { state: "running", agent: worker([scout]) })]),
    ]);
    await send([
      lane([
        step("T5", { agent: worker([]) }),
        step("T7", {
          kind: "fix",
          stage: "review",
          round: 1,
          state: "running",
          agent: worker([scout]),
        }),
      ]),
    ]);
    const copies = scope.querySelectorAll('[data-helper="H2"]');
    expect(copies).toHaveLength(1);
    expect(copies[0]?.closest(".react-flow__node")?.getAttribute("data-id")).toBe("step:T7");
    expect(copies[0]?.classList).not.toContain("pop");
    expect(copies[0]?.classList).not.toContain("bud");
  });

  it("does not bud a helper again when it moves after its bud ended", async () => {
    const worker = (helpers: GraphHelper[]) => agent("S5", "L5", { helpers });
    const lane = (steps: GraphStep[]): GraphTree => ({
      ...runTree,
      groups: [group("PR5", "L5", steps)],
    });
    const { scope, send } = await render([
      lane([step("T5", { state: "running", agent: worker([]) })]),
    ]);
    await send([lane([step("T5", { state: "running", agent: worker([scout]) })])]);
    expect(helperEl(scope, "H2")?.classList).toContain("bud");
    await end(scope, "H2");
    expect(helperEl(scope, "H2")?.classList).not.toContain("bud");
    await send([
      lane([
        step("T5", { agent: worker([]) }),
        step("T7", {
          kind: "fix",
          stage: "review",
          round: 1,
          state: "running",
          agent: worker([scout]),
        }),
      ]),
    ]);
    expect(helperEl(scope, "H2")?.closest(".react-flow__node")?.getAttribute("data-id")).toBe(
      "step:T7",
    );
    expect(helperEl(scope, "H2")?.classList).not.toContain("bud");
  });

  it("does not show a helper that ended in a hidden project when that project is shown", async () => {
    const other = (helpers: GraphHelper[]): GraphTree => ({
      ...workspaceTree,
      root: { ...workspaceTree.root, helpers },
    });
    const { scope, send, show } = await render([runTree, other([scout])], "p1");
    await send([runTree, other([{ ...scout, state: "done" }])]);
    await send([runTree, other([])]);
    await show("p2");
    expect(podLinks(scope)).toContain("#/workspaces/W2/chats/C2");
    expect(helperEl(scope, "H2")).toBeNull();
  });

  it("does not bud a helper when its project is shown after the helper came", async () => {
    const explorer: GraphHelper = { ...researcher, id: "H3", agent: "explorer" };
    const other = (helpers: GraphHelper[]): GraphTree => ({
      ...workspaceTree,
      root: { ...workspaceTree.root, helpers },
    });
    const { scope, send, show } = await render([runTree, other([])], "p1");
    // It comes while its project is hidden.
    await send([runTree, other([scout])]);
    await show("p2");
    expect(helperEl(scope, "H2")?.classList).not.toContain("bud");
    // It comes while its project is shown, and the user leaves before its bud ends.
    await send([runTree, other([scout, explorer])]);
    expect(helperEl(scope, "H3")?.classList).toContain("bud");
    await show("p1");
    await show("p2");
    expect(helperEl(scope, "H3")?.classList).not.toContain("bud");
  });

  it("buds a helper that a later event brings, not one of the snapshot", async () => {
    const { scope, send } = await render([withHelpers([researcher], [])]);
    expect(helperEl(scope, "H1")?.classList).not.toContain("bud");
    await send([withHelpers([researcher], [scout])]);
    expect(helperEl(scope, "H2")?.classList).toContain("bud");
    expect(helperEl(scope, "H1")?.classList).not.toContain("bud");
  });
});
