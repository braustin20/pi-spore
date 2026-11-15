import { type GraphHelper, type GraphTree, stepNodeId, treeNodeId } from "@pi-spore/shared";
import { cn } from "@pi-spore/ui";
import { type CSSProperties, createContext, useContext, useMemo, useState } from "react";
import { HELPER_ROW, shortModel } from "./layout.js";

/** `bud`: arrived after the page's first snapshot, until its bud ends. `done` and `failed` pop, then leave. */
type Phase = "show" | "bud" | "done" | "failed";
/** One helper on the canvas, under its owner node (a node id of the layout). */
export type HelperLife = { helper: GraphHelper; owner: string; phase: Phase };

const ended = (life: HelperLife) => life.phase === "done" || life.phase === "failed";

/** Each helper of the graph with its node, and every node id. */
function placed(trees: readonly GraphTree[]) {
  const helpers = new Map<string, { helper: GraphHelper; owner: string }>();
  const nodes = new Set<string>();
  const add = (owner: string, list: readonly GraphHelper[]) => {
    nodes.add(owner);
    for (const helper of list) helpers.set(helper.id, { helper, owner });
  };
  for (const tree of trees) {
    add(treeNodeId(tree), tree.root.helpers);
    for (const group of tree.groups)
      for (const step of group.steps) add(stepNodeId(step), step.agent?.helpers ?? []);
  }
  return { helpers, nodes };
}

/**
 * The next lives from the last ones and the graph, in a stable order so no helper jumps a row. A helper that moves
 * to another node (a reused stage agent's helpers go to its newest step) moves with its phase. An ended helper keeps
 * its pop; one that leaves the graph without an end state pops as `done`. A life whose node is gone has nowhere to
 * pop, so it goes at once.
 */
function next(lives: readonly HelperLife[], trees: readonly GraphTree[], snapshot: boolean) {
  const { helpers, nodes } = placed(trees);
  const kept = lives.map((life): HelperLife => {
    const now = helpers.get(life.helper.id);
    if (ended(life)) return life;
    if (!now) return { ...life, phase: "done" };
    return { ...now, phase: now.helper.state === "running" ? life.phase : now.helper.state };
  });
  const known = new Set(lives.map((life) => life.helper.id));
  const added = [...helpers.values()]
    .filter(({ helper }) => !known.has(helper.id))
    .map(
      (now): HelperLife => ({
        ...now,
        phase: now.helper.state !== "running" ? now.helper.state : snapshot ? "show" : "bud",
      }),
    );
  return [...kept, ...added].filter((life) => nodes.has(life.owner));
}

/**
 * The helpers of the whole graph with their client-side life (ADR 0176, "Helpers"), by node. `all` is every tree, so
 * a project switch does not bud the helpers it shows; `shown` is the trees on the canvas. Helpers of the page's first
 * snapshot show without the bud. Each event is a new array, so a new `all` means a new event. A helper leaves its
 * bud or its life when `end` is called from its spore's `animationend`. A helper off the canvas has no spore to end:
 * an ended one goes at once, and a budding one skips its bud, so it does not bud when its project is shown.
 */
export function useHelpers(
  all: readonly GraphTree[] | undefined,
  shown: readonly GraphTree[] | undefined,
) {
  const [state, setState] = useState<{
    all: readonly GraphTree[] | undefined;
    shown: readonly GraphTree[] | undefined;
    lives: readonly HelperLife[];
  }>({ all: undefined, shown: undefined, lives: [] });
  let current = state;
  if (all && shown && (state.all !== all || state.shown !== shown)) {
    // A project switch alone is no event: it must not add again a helper whose pop already ended.
    const lives = state.all === all ? state.lives : next(state.lives, all, state.all === undefined);
    const onCanvas = placed(shown).nodes;
    current = {
      all,
      shown,
      lives: lives.flatMap((life): HelperLife[] => {
        if (onCanvas.has(life.owner)) return [life];
        if (ended(life)) return [];
        return [life.phase === "bud" ? { ...life, phase: "show" } : life];
      }),
    };
    setState(current);
  }
  const { lives } = current;
  const byNode = useMemo(() => {
    const map = new Map<string, HelperLife[]>();
    for (const life of lives) map.set(life.owner, [...(map.get(life.owner) ?? []), life]);
    return map;
  }, [lives]);
  const end = (id: string) =>
    setState((now) => ({
      ...now,
      lives: now.lives.flatMap((life): HelperLife[] => {
        if (life.helper.id !== id) return [life];
        return ended(life) ? [] : [{ ...life, phase: "show" }];
      }),
    }));
  return { byNode, end };
}

/** The graph's helpers and the spore's `end`, for the nodes that React Flow renders. */
export const HelpersContext = createContext<ReturnType<typeof useHelpers> | undefined>(undefined);

const SPORE_R = 7;
/** The pop's 7 bits: where each flies to, and its size (the mockup's burst). */
const BITS = Array.from({ length: 7 }, (_, k) => {
  const angle = (k / 7) * Math.PI * 2 + 0.4;
  const dist = 15 + (k % 3) * 4;
  return { bx: Math.cos(angle) * dist, by: Math.sin(angle) * dist, size: 3.6 + (k % 2) * 1.4 };
});

/**
 * A node's helpers: small spores on short threads, below and right of the pod, one row each, each a little further
 * right. They sit inside the pod's link, so a click opens the parent's chat. Coordinates are the pod's own: its
 * circle's center is at (r, 22).
 */
export function Helpers({ node, r }: { node: string; r: number }) {
  const context = useContext(HelpersContext);
  if (!context) throw new Error("Helpers must be inside HelpersContext");
  const { byNode, end } = context;
  const lives = byNode.get(node) ?? [];
  // The thread starts at the lower right of the pod's circle.
  const sx = r * 1.55;
  const sy = 22 + r * 0.8;
  return lives.map((life, index) => {
    const { helper, phase } = life;
    const x = r * 2 + 16 + index * 8;
    const y = 22 + 42 + index * HELPER_ROW;
    const name = helper.agent ?? "helper";
    const pop = ended(life);
    return (
      <span
        key={helper.id}
        data-helper={helper.id}
        className={cn(
          "ag-helper",
          phase === "bud" && "bud",
          pop && "pop",
          phase === "failed" && "fail",
        )}
        title={[name, helper.currentTool].filter(Boolean).join(" · ")}
        style={{ left: x, top: y, "--dx": `${sx - x}px`, "--dy": `${sy - y}px` } as CSSProperties}
      >
        <svg className="ag-hthread" aria-hidden="true">
          <path pathLength={1} d={`M${sx - x},${sy - y} C${r * 1.7 - x},-2 -12,0 ${-SPORE_R},0`} />
        </svg>
        <span className="ag-spore" onAnimationEnd={() => end(helper.id)} />
        {pop && (
          <>
            <span className="ag-ring" />
            {BITS.map((bit) => (
              <span
                key={`${bit.bx},${bit.by}`}
                className="ag-bit"
                style={
                  {
                    "--bx": `${bit.bx}px`,
                    "--by": `${bit.by}px`,
                    width: bit.size,
                    height: bit.size,
                    left: -bit.size / 2,
                    top: -bit.size / 2,
                  } as CSSProperties
                }
              />
            ))}
          </>
        )}
        <span className="ag-hlabel">
          <span className="ag-hname">{name}</span>
          <span className="ag-hmodel">{shortModel(helper.model)}</span>
          {/* A tap opens the parent's chat, so on touch the tool shows inline instead of on hover. */}
          {helper.currentTool && <span className="ag-htool">· {helper.currentTool}</span>}
        </span>
      </span>
    );
  });
}
