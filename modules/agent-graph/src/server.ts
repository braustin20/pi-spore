import { AgentsKey } from "@pi-spore/mod-agents/server";
import { PipelinesKey } from "@pi-spore/mod-pipelines/server";
import { RunsKey } from "@pi-spore/mod-runs/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  type AgentGraph,
  type AgentGraphEvent,
  type ChildRun,
  type GraphHelper,
  type GraphPosition,
  type GraphTree,
  groupNodeId,
  parseJsonBody,
  SavePositionRequest,
  stepNodeId,
  treeNodeId,
} from "@pi-spore/shared";
import { buildGraph, nodesOf } from "./graph.js";

export const GRAPH_TOPIC = "agent-graph:trees";

const MIGRATIONS = [
  // ADR 0176, card 4: where the user dragged each node, by canvas node id, under the workspace of its tree.
  `CREATE TABLE agent_graph_positions (
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    PRIMARY KEY (workspace_id, node_id)
  )`,
];

/** The tree of the graph that shows this canvas node id, by its tree, group, or step node. Helpers have none. */
function treeOfNode(trees: readonly GraphTree[], node: string): GraphTree | undefined {
  return trees.find(
    (tree) =>
      treeNodeId(tree) === node ||
      tree.groups.some(
        (group) =>
          groupNodeId(group) === node || group.steps.some((step) => stepNodeId(step) === node),
      ),
  );
}

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
 * topic `agent-graph:trees`, built from the agents, pipelines, runs, and workspaces interfaces. Its one table keeps
 * where the user dragged each node (card 4); a workspace's rows go when it is archived or deleted.
 */
export const agentGraphModule: ServerModule = {
  id: "agent-graph",
  requires: ["projects", "workspaces", "agents", "pipelines", "runs"],
  core: false,
  setup(host) {
    host.store.migrate("agent-graph", MIGRATIONS);
    const sources = {
      agents: host.use(AgentsKey),
      pipelines: host.use(PipelinesKey),
      runs: host.use(RunsKey),
      workspaces: host.use(WorkspacesKey),
    };
    const { agents } = sources;

    // The one shape GET, the snapshot for a new subscriber, and each event use: the graph with its saved places.
    const graph = (): GraphTree[] => {
      const trees = buildGraph(sources);
      for (const tree of trees)
        tree.positions = Object.fromEntries(
          host.store
            .all<{ node_id: string; x: number; y: number }>(
              "SELECT node_id, x, y FROM agent_graph_positions WHERE workspace_id = ?",
              tree.workspaceId,
            )
            .map((row): [string, GraphPosition] => [row.node_id, { x: row.x, y: row.y }]),
        );
      return trees;
    };
    const deleteRows = (workspaceId: string) =>
      host.store.run("DELETE FROM agent_graph_positions WHERE workspace_id = ?", workspaceId);

    // The running helpers of the last event, by agent id, so the next event can show each one that ended once.
    let shown = new Map<string, GraphHelper[]>();
    const publish = () => {
      const trees = graph();
      // Each agent once, on the node that carries its helpers: its last one (see buildGraph).
      const nodes = [...new Map(nodesOf(trees).map((node) => [node.agentId, node])).values()];
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
    sources.workspaces.afterStateChange((workspace) => {
      // ADR 0176: an archived workspace never comes back, so its places go. A parked one can resume, so they stay.
      if (workspace.state === "archived") deleteRows(workspace.id);
      changed();
    });
    sources.workspaces.beforeDeleteWorkspace(async (workspace) => {
      deleteRows(workspace.id);
      changed();
    });

    host.events.onSubscribe(GRAPH_TOPIC, (): AgentGraphEvent[] => [
      { type: "graph", trees: graph() },
    ]);
    host.routes.get("/", (c) => c.json({ trees: graph() } satisfies AgentGraph));

    host.routes.put("/positions", async (c) => {
      const request = parseJsonBody(
        SavePositionRequest,
        await c.req.text(),
        "save position request",
      );
      const tree = treeOfNode(buildGraph(sources), request.node);
      if (!tree)
        throw new ApiError(
          400,
          "unknown_node",
          `No graph node ${request.node}: save a tree, group, or step node of the graph`,
        );
      host.store.run(
        `INSERT INTO agent_graph_positions (workspace_id, node_id, x, y) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, node_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
        tree.workspaceId,
        request.node,
        request.x,
        request.y,
      );
      changed();
      return c.json({ ok: true });
    });

    // The canvas's "Reset layout": every tree goes back to its automatic place.
    host.routes.delete("/positions", (c) => {
      host.store.run("DELETE FROM agent_graph_positions");
      changed();
      return c.json({ ok: true });
    });
  },
};
