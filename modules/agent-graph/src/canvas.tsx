import "@xyflow/react/dist/base.css";
import "./graph.css";
import type { UseUserWaits } from "@pi-spore/mod-agents/web";
import { useApi } from "@pi-spore/module-api";
import type { AgentGraphEvent, GraphAgent, GraphStep, GraphTree } from "@pi-spore/shared";
import { Button, cn, EmptyState, Notice, SporeLogo, usePhone } from "@pi-spore/ui";
import {
  Background,
  type EdgeProps,
  Handle,
  type NodeChange,
  type NodeHandle,
  type NodeProps,
  Panel,
  ReactFlow,
  useReactFlow,
  type XYPosition,
} from "@xyflow/react";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Helpers, HelpersContext, useHelpers } from "./helpers.js";
import {
  type GraphNode,
  type GroupNode,
  type HelpersByNode,
  layoutGraph,
  type PodState,
  rootHandles,
  rootState,
  STAGE_R,
  type StepNode,
  shortModel,
  stepHandles,
  stepState,
  type ThreadEdge,
  type TreeNode,
  type Waits,
} from "./layout.js";

const STATE_TEXT: Record<PodState, string> = {
  work: "working",
  idle: "idle",
  none: "not started",
  fail: "failed",
  wait: "waiting for your answer",
};

/** The chats that wait for the user, for the pods React Flow renders. */
const WaitsContext = createContext<Waits>(new Map());

/** React Flow measures handles in the DOM, so these sit exactly where the layout's `handles` say. */
function Handles({ handles }: { handles: readonly NodeHandle[] }) {
  return handles.map((each) => (
    <Handle
      key={each.id}
      id={each.id ?? null}
      type={each.type}
      position={each.position}
      isConnectable={false}
      className="ag-handle"
      style={{ left: each.x, top: each.y }}
    />
  ));
}

/** A pod: a link to its agent's chat, or a plain box for a step without an agent. Its helpers go in `children`. */
function Pod({
  agent,
  className,
  style,
  shape,
  role,
  title,
  meta,
  children,
}: {
  agent: GraphAgent | undefined;
  className: string;
  style?: CSSProperties;
  shape?: ReactNode;
  role: string;
  title: string | undefined;
  meta: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="ag-shape">{shape}</span>
      <span className="ag-text">
        <span className="ag-role">{role}</span>
        <span className="ag-title">{title}</span>
        <span className="ag-meta">{meta}</span>
      </span>
      {children}
    </>
  );
  const props = { className: cn("ag-pod", className), style, "data-pod": "" };
  return agent ? (
    <a
      {...props}
      href={`#/workspaces/${agent.workspaceId}/chats/${agent.agentId}`}
      draggable={false}
    >
      {body}
    </a>
  ) : (
    <div {...props}>{body}</div>
  );
}

/** The server makes a workspace's root its worker chat; `orchestrator` is the role of every workspace chat. */
function rootRole(tree: GraphTree): string {
  if (tree.kind === "run") return "coordinator";
  return tree.root.role === "orchestrator" ? `${tree.root.kind} chat` : tree.root.role;
}

function TreeBox({ id, data, width }: NodeProps<TreeNode>) {
  const { tree, tone, root, live } = data;
  const state = rootState(tree.root, useContext(WaitsContext).get(tree.root.agentId));
  const status =
    state === "wait" ? STATE_TEXT.wait : tree.root.status === "busy" ? "working" : tree.root.status;
  return (
    <div className={cn("ag-tree", live && "live")}>
      <div className="ag-tree-name">{tree.name}</div>
      <Pod
        agent={tree.root}
        // `ag-root` is the tree's drag handle.
        className={cn("ag-root", `t-${tone}`, `s-${state}`)}
        style={
          {
            "--r": `${root.r}px`,
            left: root.x - root.r,
            top: root.y - 22,
            // The text stops at the box's padding.
            maxWidth: (width ?? 0) - (root.x - root.r) - 18,
          } as CSSProperties
        }
        shape={<SporeLogo />}
        role={rootRole(tree)}
        title={tree.root.title}
        meta={`${status} · ${shortModel(tree.root.routedModel ?? tree.root.model)}`}
      >
        <Helpers node={id} r={root.r} />
      </Pod>
      <Handles handles={rootHandles(root)} />
    </div>
  );
}

function GroupPanel({ data }: NodeProps<GroupNode>) {
  const { merging } = data.group;
  return (
    <div className={cn("ag-group", (data.group.live || merging !== undefined) && "live")}>
      <div className="ag-group-name">{data.group.name}</div>
      {merging !== undefined && (
        <div className="ag-group-merging">
          {merging === "merging" ? merging : `merging: ${merging}`}
        </div>
      )}
    </div>
  );
}

/** "implement", "review r1", "fix r1", "gates". A fix step carries its review's stage name, so it shows its kind. */
function stepRole(step: GraphStep): string {
  const name = step.kind === "fix" ? "fix" : step.stage;
  return step.round === undefined || step.kind === "task" ? name : `${name} r${step.round}`;
}

/**
 * What a step's pod says about how the step ended, or why it waits (ADR 0187): the word for its meta line, and the
 * ring tone that goes with it. `reported` has no tone: it only says the agent finished its turn.
 */
function stepOutcome(step: GraphStep): { text: string; tone: string | undefined } | undefined {
  if (step.outcome === undefined) return undefined;
  const findings =
    step.outcome === "revise" && step.findings !== undefined
      ? ` · ${step.findings} finding${step.findings === 1 ? "" : "s"}`
      : "";
  return {
    text: `${step.outcome}${findings}`,
    tone:
      step.outcome === "approved" || step.outcome === "passed"
        ? "o-ok"
        : step.outcome === "revise" || step.outcome === "asking"
          ? "o-warn"
          : step.outcome === "blocked"
            ? "o-fail"
            : undefined,
  };
}

function StepPod({ id, data }: NodeProps<StepNode>) {
  const { step } = data;
  const waits = useContext(WaitsContext);
  const state = stepState(step, step.agent && waits.get(step.agent.agentId));
  const outcome = stepOutcome(step);
  // A step that waits says why, on a line under its title.
  const title = [step.agent?.title ?? step.gates?.join(" · "), step.note]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <Pod
        agent={step.agent}
        className={cn("ag-step", `s-${state}`, outcome?.tone)}
        style={{ "--r": `${STAGE_R}px` } as CSSProperties}
        shape={
          state === "fail" && (
            <svg viewBox="-14 -14 28 28" aria-hidden="true">
              <path d="M-4.2,-4.2L4.2,4.2M4.2,-4.2L-4.2,4.2" />
            </svg>
          )
        }
        role={stepRole(step)}
        title={title || undefined}
        meta={`${outcome?.text ?? STATE_TEXT[state]} · ${shortModel(step.agent?.routedModel ?? step.agent?.model)}`}
      >
        {step.agent && <Helpers node={id} r={STAGE_R} />}
      </Pod>
      <Handles handles={stepHandles} />
    </>
  );
}

function threadPath(x1: number, y1: number, x2: number, y2: number, stacked: boolean, bend = 0) {
  // On a phone the root thread runs down the left, then turns into the group's first step.
  if (stacked && x2 !== x1)
    return `M${x1},${y1} L${x1},${y2 - 46} C${x1 + bend},${y2 - 16} ${x2},${y2 - 34} ${x2},${y2}`;
  const dy = y2 - y1;
  return `M${x1},${y1} C${x1 + bend},${y1 + dy * 0.45 - bend * 0.6} ${x2},${y2 - dy * 0.7} ${x2},${y2}`;
}

/** A tapered drop, pointed at both ends, round in the middle. */
const SPINDLE =
  "M-13,0 C-8,-0.5 -5,-4.3 0,-4.3 C5,-4.3 8,-0.5 13,0 C8,0.5 5,4.3 0,4.3 C-5,4.3 -8,0.5 -13,0Z";

/** Drops ride a live thread at about 62 px/s, one per 95 px, and stretch as they go. SVG animation, no JS loop. */
function Drops({ d, length }: { d: string; length: number }) {
  const dur = length / 62;
  const count = Math.max(1, Math.round(length / 95));
  const fade = Math.min(0.2, 8 / length);
  return (
    <g className="ag-drops">
      {Array.from({ length: count }, (_, i) => {
        const begin = `${(-i * dur) / count}s`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the drops are a fixed row; the index is their identity.
          <g key={i}>
            <path className="ag-drop" d={SPINDLE}>
              <animateTransform
                attributeName="transform"
                type="scale"
                values="0.75 1.1;1.3 0.85;0.75 1.1"
                dur="1.6s"
                begin={begin}
                repeatCount="indefinite"
              />
            </path>
            <animateMotion
              path={d}
              dur={`${dur}s`}
              begin={begin}
              repeatCount="indefinite"
              rotate="auto"
              calcMode="linear"
              keyPoints="0;1"
              keyTimes="0;1"
            />
            <animate
              attributeName="opacity"
              values="0;1;1;0"
              keyTimes={`0;${fade};${1 - fade * 3};1`}
              dur={`${dur}s`}
              begin={begin}
              repeatCount="indefinite"
            />
          </g>
        );
      })}
    </g>
  );
}

function Thread({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<ThreadEdge>) {
  // The layout gives every thread its data.
  const { tone, live, dim, stacked } = data as NonNullable<ThreadEdge["data"]>;
  const d = threadPath(sourceX, sourceY, targetX, targetY, stacked);
  const length = Math.hypot(targetX - sourceX, targetY - sourceY) * 1.15 + (stacked ? 40 : 0);
  return (
    <g className={cn("ag-thread", `t-${tone}`, live && "live", dim && "dim")}>
      <path className="ag-main" d={d} />
      {/* A thin twin a little off the thread makes it read as a root, not a wire. */}
      <path className="ag-twin" d={threadPath(sourceX, sourceY, targetX, targetY, stacked, 5)} />
      {live && <Drops d={d} length={length} />}
    </g>
  );
}

const nodeTypes = { tree: TreeBox, pipeline: GroupPanel, step: StepPod };
const edgeTypes = { thread: Thread };

/** A fit never zooms in past 100%, so one small tree does not fill the screen. */
const FIT = { maxZoom: 1 };

function FitButton() {
  const { fitView } = useReactFlow();
  return (
    <Button size="sm" onClick={() => void fitView(FIT)}>
      Fit
    </Button>
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Canvas({
  trees,
  helpers,
  waits,
}: {
  trees: readonly GraphTree[];
  helpers: HelpersByNode;
  waits: Waits;
}) {
  const api = useApi();
  const phone = usePhone();
  // This mount's drags, shown until the server echoes the saved place in the next topic event, and after.
  const [moved, setMoved] = useState<ReadonlyMap<string, XYPosition>>(new Map());
  const [error, setError] = useState<string | undefined>();
  const layout = useMemo(
    () => layoutGraph(trees, helpers, phone, waits),
    [trees, helpers, phone, waits],
  );
  // Node ids are unique across trees. A step's place is relative to its group, as the layout gives it.
  const saved = useMemo(
    () => new Map(trees.flatMap((tree) => Object.entries(tree.positions))),
    [trees],
  );
  const nodes = useMemo(
    () =>
      layout.nodes.map((node) => {
        const at = moved.get(node.id) ?? saved.get(node.id);
        return at ? { ...node, position: at } : node;
      }),
    [layout, moved, saved],
  );
  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    const positions = new Map<string, XYPosition>();
    for (const change of changes)
      if (change.type === "position" && change.position) positions.set(change.id, change.position);
    if (positions.size === 0) return;
    setMoved((before) => new Map([...before, ...positions]));
  }, []);
  const save = (method: "PUT" | "DELETE", body?: unknown) =>
    api.send(method, "agent-graph/positions", body).then(
      () => setError(undefined),
      (caught) => setError(message(caught)),
    );
  // A drag ends with a click on the pod under the pointer; that click must not open the chat.
  const dragged = useRef(false);
  return (
    <div
      className="relative min-h-0 flex-1"
      onPointerDownCapture={() => {
        dragged.current = false;
      }}
      onClickCapture={(event) => {
        if (dragged.current) event.preventDefault();
      }}
    >
      <ReactFlow<GraphNode, ThreadEdge>
        className="ag-canvas"
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={() => {
          dragged.current = true;
        }}
        // Once per drag, not on every move as `onNodesChange` is.
        onNodeDragStop={(_, node) =>
          void save("PUT", { node: node.id, x: node.position.x, y: node.position.y })
        }
        // On a phone the whole graph fits only at a zoom too small to read, so it starts at 100%, at the top (the
        // approved phone mockup). Fit shows it all.
        fitView={!phone}
        fitViewOptions={FIT}
        defaultViewport={{ x: 16, y: 16, zoom: 1 }}
        minZoom={0.2}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
      >
        <Background gap={16} size={2} color="color-mix(in oklab, var(--text) 10%, transparent)" />
        <Panel position="top-right" className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setMoved(new Map());
                void save("DELETE");
              }}
            >
              Reset layout
            </Button>
            <FitButton />
          </div>
          {error && <Notice tone="fail">{error}</Notice>}
        </Panel>
      </ReactFlow>
    </div>
  );
}

function summary(trees: readonly GraphTree[], waits: Waits): string {
  const states = trees.flatMap((tree) => [
    rootState(tree.root, waits.get(tree.root.agentId)),
    ...tree.groups.flatMap((group) =>
      group.steps.map((step) => stepState(step, step.agent && waits.get(step.agent.agentId))),
    ),
  ]);
  const count = (state: PodState) => states.filter((each) => each === state).length;
  return [
    `${trees.length} ${trees.length === 1 ? "workspace" : "workspaces"}`,
    `${count("work")} working`,
    ...(count("wait") > 0 ? [`${count("wait")} wait for you`] : []),
    ...(count("fail") > 0 ? [`${count("fail")} failed`] : []),
  ].join(" · ");
}

const LEGEND_TYPES = [
  ["t-coord", "coordinator"],
  ["t-chat", "orchestrator / worker chat"],
  ["t-work", "working stage"],
  ["t-idle", "idle stage"],
] as const;
const LEGEND_STATES = [
  ["work", "works"],
  ["idle", "idle"],
  ["none", "not started"],
  ["fail", "failed"],
  ["wait", "waits for you"],
] as const;

/**
 * The workspaces landing page: every agent tree, live (ADR 0176). The topic's first event is the snapshot; each
 * event is the whole graph again.
 */
export function AgentGraph({
  projectId,
  useUserWaits,
}: {
  projectId?: string | undefined;
  /** The agents module's hook for the chats that wait for the user. */
  useUserWaits: UseUserWaits;
}) {
  const api = useApi();
  const waits = useUserWaits();
  const [all, setAll] = useState<readonly GraphTree[]>();
  useEffect(
    () => api.subscribe("agent-graph:trees", (event) => setAll((event as AgentGraphEvent).trees)),
    [api],
  );
  const trees = useMemo(
    () => all?.filter((tree) => projectId === undefined || tree.projectId === projectId),
    [all, projectId],
  );
  const helpers = useHelpers(all, trees);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 px-7 pt-5 pb-2 max-md:px-4">
        <div className="flex flex-wrap items-center gap-3">
          <SporeLogo className="size-6 text-accent" />
          <h1 className="m-0 text-lg font-semibold">Agents</h1>
          {trees && <span className="text-[13px] text-muted">{summary(trees, waits)}</span>}
        </div>
        <div className="ag-legend">
          {LEGEND_TYPES.map(([tone, label]) => (
            <span key={label} className={tone}>
              <i />
              {label}
            </span>
          ))}
          <span className="ag-sep" />
          {LEGEND_STATES.map(([state, label]) => (
            <span key={label}>
              <i className={cn("st", state)} />
              {label}
            </span>
          ))}
        </div>
      </header>
      {trees?.length === 0 && (
        <EmptyState
          title="No agents work now."
          action={
            <Button variant="primary" asChild>
              <a href={projectId ? `#/workspaces/new/in/${projectId}` : "#/workspaces/new"}>
                New workspace
              </a>
            </Button>
          }
        />
      )}
      {trees && trees.length > 0 && (
        <HelpersContext value={helpers}>
          <WaitsContext value={waits}>
            <Canvas trees={trees} helpers={helpers.byNode} waits={waits} />
          </WaitsContext>
        </HelpersContext>
      )}
    </div>
  );
}
