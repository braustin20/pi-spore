import { type UserWait, waitShows } from "@pi-spore/mod-agents/web";
import {
  type GraphAgent,
  type GraphGroup,
  type GraphStep,
  type GraphTree,
  groupNodeId,
  stepNodeId,
  treeNodeId,
} from "@pi-spore/shared";
import { type Edge, type Node, type NodeHandle, Position } from "@xyflow/react";
import type { HelperLife } from "./helpers.js";

/**
 * How a pod looks: working, idle (done or an idle agent), not started, failed (ADR 0176, the approved mockup), or
 * waiting for the user's answer.
 */
export type PodState = "work" | "idle" | "none" | "fail" | "wait";

/** The chats that wait for the user, by agent id. */
export type Waits = ReadonlyMap<string, UserWait>;

/** The thread and root colors: coordinator `--accent`, a chat `--accent-strong`, else muted. */
export type Tone = "coord" | "chat" | "muted";

export type TreeNode = Node<
  { tree: GraphTree; tone: Tone; root: { x: number; y: number; r: number }; live: boolean },
  "tree"
>;
// Not "group": React Flow styles its own group type.
export type GroupNode = Node<{ group: GraphGroup }, "pipeline">;
export type StepNode = Node<{ step: GraphStep }, "step">;
export type GraphNode = TreeNode | GroupNode | StepNode;
export type ThreadEdge = Edge<
  { tone: Tone; live: boolean; dim: boolean; stacked: boolean },
  "thread"
>;

// Sizes from the approved mockup, in px.
const ROOT_R = { coord: 22, chat: 21 } as const;
export const STAGE_R = 14;
const GROUP_W = 236;
const GROUP_GAP = 14;
const STEP = 72;
/** One row under a pod per helper, popping ones too, so helpers never cover the next node. */
export const HELPER_ROW = 26;
const PAD = 18;
const HEADER = 44;
const TREE_GAP = 22;
/** A step node's box: the pod's center sits at (STAGE_R, STEP_CY), the text to its right. */
const STEP_W = GROUP_W - 26;
const STEP_H = 50;
const STEP_CY = 22;
/**
 * A parallel round's column: its members sit side by side, this far apart, and the group widens by this much per
 * member past the first. Wide enough that `adversarial r1` still reads.
 */
const COL_W = 170;
/** The space between a member's text and the next member's pod. */
const COL_GAP = 10;

/** The helpers shown under each node, by node id. */
export type HelpersByNode = ReadonlyMap<string, readonly HelperLife[]>;

/** `anthropic/claude-opus-5-5` -> `opus 5.5`. */
export function shortModel(ref: string | undefined): string {
  if (ref === undefined) return "—";
  return ref
    .slice(ref.lastIndexOf("/") + 1)
    .replace(/^claude-/, "")
    .replace(/(\d)-(?=\d)/g, "$1.")
    .replaceAll("-", " ");
}

/**
 * From the step's own state, never its agent's status: a task step and its fix steps share one worker agent, so
 * during a fix the done task step's agent is busy too. Only a running step shows its agent's wait.
 */
export function stepState(step: GraphStep, wait: UserWait | undefined): PodState {
  if (step.state === "failed") return "fail";
  if (step.state === "waiting") return "none";
  if (step.state === "done") return "idle";
  return step.agent && waitShows(step.agent.status, wait) ? "wait" : "work";
}

export function rootState(agent: GraphAgent, wait: UserWait | undefined): PodState {
  if (waitShows(agent.status, wait)) return "wait";
  if (agent.status === "busy" || agent.status === "starting") return "work";
  return agent.status === "failed" ? "fail" : "idle";
}

const handle = (id: string, type: "source" | "target", x: number, y: number): NodeHandle => ({
  id,
  type,
  position: type === "source" ? Position.Bottom : Position.Top,
  // A 1 px handle: a Bottom handle's point is its bottom edge, a Top handle's its top edge.
  x: x - 0.5,
  y: type === "source" ? y - 1 : y,
  width: 1,
  height: 1,
});

/** The node box and handles of a pod, given the same way React Flow would measure them, so no layout pass is needed. */
const sized = (width: number, height: number) => ({ width, height, measured: { width, height } });

export const stepHandles = [
  handle("in", "target", STAGE_R, STEP_CY - STAGE_R),
  handle("out", "source", STAGE_R, STEP_CY + STAGE_R),
];

/** The root pod's handle: the bottom of its circle, where its threads start. */
export const rootHandles = (root: { x: number; y: number; r: number }) => [
  handle("root", "source", root.x, root.y + root.r),
];

/** A group's steps in rounds: a step with `beside` joins the round before it (ADR 0178). */
function toRounds(steps: readonly GraphStep[]): GraphStep[][] {
  const rounds: GraphStep[][] = [];
  for (const step of steps) {
    const last = rounds.at(-1);
    if (step.beside && last) last.push(step);
    else rounds.push([step]);
  }
  return rounds;
}

function layoutTree(
  tree: GraphTree,
  helpers: HelpersByNode,
  waits: Waits,
  phone: boolean,
  x: number,
  y: number,
) {
  const id = treeNodeId(tree);
  const rows = (nodeId: string) => helpers.get(nodeId)?.length ?? 0;
  const tone: Tone = tree.kind === "run" ? "coord" : "chat";
  const rootR = ROOT_R[tone];
  // On a phone a tree's groups stack and the root thread runs down the left.
  const stacked = phone && tree.groups.length > 1;
  const perRow = phone ? 1 : Math.max(1, tree.groups.length);
  const ry = HEADER + rootR + 6;
  let top = ry + Math.max(30, rootR + rows(id) * HELPER_ROW) + 30;
  const gx0 = stacked ? PAD + 34 : PAD;
  // On a desktop a group widens to fit its widest round side by side.
  const groupW = (group: GraphGroup) =>
    phone
      ? GROUP_W
      : GROUP_W + (Math.max(1, ...toRounds(group.steps).map((round) => round.length)) - 1) * COL_W;
  const rowW = tree.groups
    .slice(0, perRow)
    .reduce((sum, group) => sum + groupW(group) + GROUP_GAP, -GROUP_GAP);
  const rx = stacked || tree.groups.length <= 1 ? PAD + 32 : PAD + rowW / 2 - 70;

  const groups: GroupNode[] = [];
  const steps: StepNode[] = [];
  const edges: ThreadEdge[] = [];
  for (let row = 0; row < tree.groups.length; row += perRow) {
    // Each pod's place in its group, then the row's height from the tallest group.
    const placed = tree.groups.slice(row, row + perRow).map((group) => {
      const rounds = toRounds(group.steps);
      let podY = 56;
      const lines = rounds.map((round) => {
        const wide = !phone && round.length > 1;
        const line = round.map((step, column) => {
          const at = { step, x: 32 - STAGE_R + (wide ? column * COL_W : 0), y: podY };
          if (phone) podY += STEP + rows(stepNodeId(step)) * HELPER_ROW;
          return at;
        });
        if (!phone)
          podY += STEP + Math.max(...round.map((step) => rows(stepNodeId(step)))) * HELPER_ROW;
        return { line, stepW: wide ? COL_W - COL_GAP : STEP_W };
      });
      return { group, lines, width: groupW(group), height: podY - STEP + 38 };
    });
    const rowH = Math.max(56, ...placed.map(({ height }) => height));
    let gx = gx0;
    for (const { group, lines, width } of placed) {
      const groupId = groupNodeId(group);
      groups.push({
        id: groupId,
        type: "pipeline",
        parentId: id,
        position: { x: gx, y: top },
        draggable: false,
        data: { group },
        ...sized(width, rowH),
      });
      gx += width + GROUP_GAP;
      // The route ends at the last round with a running step. It runs from the root through each earlier round's
      // first step, and to every running step. It keeps its color in a group that is not live; only `live` waits
      // for the group.
      const end = lines.findLastIndex(({ line }) =>
        line.some(({ step }) => step.state === "running"),
      );
      const onRoute = (step: GraphStep, round: number, column: number) =>
        round <= end && (step.state === "running" || (round < end && column === 0));
      let sources = [{ id, handle: "root", onRoute: true }];
      lines.forEach(({ line, stepW }, round) => {
        for (const [column, { step, x, y }] of line.entries()) {
          const stepId = stepNodeId(step);
          steps.push({
            id: stepId,
            type: "step",
            parentId: groupId,
            position: { x, y: y - STEP_CY },
            data: { step },
            handles: stepHandles,
            ...sized(stepW, STEP_H),
          });
          const target = onRoute(step, round, column);
          for (const source of sources) {
            const route = source.onRoute && target;
            const live = route && group.live;
            edges.push({
              id: sources.length === 1 ? `thread:${stepId}` : `thread:${source.id}:${stepId}`,
              type: "thread",
              source: source.id,
              sourceHandle: source.handle,
              target: stepId,
              targetHandle: "in",
              data: {
                tone: route || round === 0 ? tone : "muted",
                live,
                dim: round === 0 ? !group.live : step.state === "waiting",
                stacked: round === 0 && stacked,
              },
            });
          }
        }
        sources = line.map(({ step }, column) => ({
          id: stepNodeId(step),
          handle: "out",
          onRoute: onRoute(step, round, column),
        }));
      });
    }
    top += rowH + 24;
  }

  const width = gx0 + Math.max(rowW, 240) + PAD;
  const height = top - 24 + PAD;
  const treeNode: TreeNode = {
    id,
    type: "tree",
    position: { x, y },
    // Dragged only by its root pod; the rest of the box pans the canvas.
    dragHandle: ".ag-root",
    style: { pointerEvents: "none" },
    data: {
      tree,
      tone,
      root: { x: rx, y: ry, r: rootR },
      live:
        rootState(tree.root, waits.get(tree.root.agentId)) === "work" ||
        tree.groups.some((group) => group.live),
    },
    handles: rootHandles({ x: rx, y: ry, r: rootR }),
    ...sized(width, height),
  };
  return { nodes: [treeNode, ...groups, ...steps], edges, width, height };
}

/**
 * The fixed tree layout. Desktop: trees side by side in event order, a tree's groups side by side under its root,
 * steps top-down. Phone: trees stacked, groups stacked. Parents come before their children, as React Flow needs.
 */
export function layoutGraph(
  trees: readonly GraphTree[],
  helpers: HelpersByNode,
  phone: boolean,
  waits: Waits = new Map(),
): { nodes: GraphNode[]; edges: ThreadEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: ThreadEdge[] = [];
  let offset = 0;
  for (const tree of trees) {
    const placed = phone
      ? layoutTree(tree, helpers, waits, true, 0, offset)
      : layoutTree(tree, helpers, waits, false, offset, 0);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges);
    offset += (phone ? placed.height : placed.width) + TREE_GAP;
  }
  return { nodes, edges };
}
