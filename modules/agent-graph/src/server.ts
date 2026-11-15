import { AgentsKey } from "@pi-spore/mod-agents/server";
import { PipelinesKey } from "@pi-spore/mod-pipelines/server";
import { RunsKey } from "@pi-spore/mod-runs/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import type {
  AgentGraph,
  AgentGraphEvent,
  ChildRun,
  GraphAgent,
  GraphHelper,
  GraphTree,
} from "@pi-spore/shared";
import { buildGraph } from "./graph.js";

export const GRAPH_TOPIC = "agent-graph:trees";

const nodesOf = (trees: GraphTree[]): GraphAgent[] =>
  trees.flatMap((tree) => [
    tree.root,
    ...tree.groups.flatMap((group) => group.steps.flatMap((step) => step.agent ?? [])),
  ]);

/** How a helper that stopped running ended: `failed` for a failed or rejected step or run, else `done`. */
function endState(children: ChildRun[], helperId: string): "done" | "failed" {
  const cut = helperId.lastIndexOf(":");
  const run = children.find((entry) => entry.id === helperId.slice(0, cut));
  const step = run?.steps[Number(helperId.slice(cut + 1))];
  const failed = (state: string | undefined) => state === "failed" || state === "rejected";
  return failed(run?.state) || failed(step?.state) ? "failed" : "done";
}

/**
 * The live agent graph (ADR 0176): every active workspace's agents as trees, at `GET /api/agent-graph` and on
 * topic `agent-graph:trees`, built from the agents, pipelines, runs, and workspaces interfaces. It stores nothing.
 */
export const agentGraphModule: ServerModule = {
  id: "agent-graph",
  requires: ["projects", "workspaces", "agents", "pipelines", "runs"],
  core: false,
  setup(host) {
    const sources = {
      agents: host.use(AgentsKey),
      pipelines: host.use(PipelinesKey),
      runs: host.use(RunsKey),
      workspaces: host.use(WorkspacesKey),
    };
    const { agents } = sources;

    // The running helpers of the last event, by agent id, so the next event can show each one that ended once.
    let shown = new Map<string, GraphHelper[]>();
    const publish = () => {
      const trees = buildGraph(sources);
      const nodes = nodesOf(trees);
      const running = new Map(nodes.map((node) => [node.agentId, node.helpers]));
      let ended = false;
      for (const node of nodes) {
        const now = new Set(node.helpers.map((helper) => helper.id));
        const gone = (shown.get(node.agentId) ?? []).filter((helper) => !now.has(helper.id));
        if (gone.length === 0) continue;
        const { children } = agents.liveState(node.agentId);
        node.helpers = [
          ...node.helpers,
          ...gone.map((helper) => ({ ...helper, state: endState(children, helper.id) })),
        ];
        ended = true;
      }
      shown = running;
      const event: AgentGraphEvent = { type: "graph", trees };
      host.events.publish(GRAPH_TOPIC, event);
      // The ended helpers are shown once; the next event drops them.
      if (ended) changed();
    };

    // Changes come in bursts (a status, then a child run); one graph per tick is enough.
    let scheduled = false;
    const changed = () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        try {
          publish();
        } catch (error) {
          host.log.error("Agent graph failed", { error: String(error) });
        }
      });
    };
    agents.onChange(changed);
    // A new worker chat fires no onChange, and it can be a workspace's first, so its tree is new.
    agents.afterWorkerChange(changed);
    sources.pipelines.onChange(changed);
    sources.runs.onChange(changed);
    sources.workspaces.afterStateChange(changed);
    sources.workspaces.beforeDeleteWorkspace(async () => changed());

    host.events.onSubscribe(GRAPH_TOPIC, (): AgentGraphEvent[] => [
      { type: "graph", trees: buildGraph(sources) },
    ]);
    host.routes.get("/", (c) => c.json({ trees: buildGraph(sources) } satisfies AgentGraph));
  },
};
