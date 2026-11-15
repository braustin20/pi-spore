import type { Agents } from "@pi-spore/mod-agents/server";
import type { Pipelines } from "@pi-spore/mod-pipelines/server";
import type { Runs } from "@pi-spore/mod-runs/server";
import type { Workspaces } from "@pi-spore/mod-workspaces/server";
import {
  type Agent,
  type ChildRun,
  type GraphAgent,
  type GraphGroup,
  type GraphHelper,
  type GraphStep,
  type GraphTree,
  type PipelineRun,
  stageGroups,
  type Workspace,
} from "@pi-spore/shared";

export interface GraphSources {
  agents: Agents;
  pipelines: Pipelines;
  runs: Runs;
  workspaces: Workspaces;
}

/** The running steps of the agent's running child runs (ADR 0176, "Helpers"). */
function helpersOf(children: ChildRun[]): GraphHelper[] {
  return children.flatMap((run) =>
    run.state !== "running"
      ? []
      : run.steps.flatMap((step, index): GraphHelper[] =>
          step.state !== "running"
            ? []
            : [
                {
                  id: `${run.id}:${index}`,
                  ...(step.agent ? { agent: step.agent } : {}),
                  ...(step.model ? { model: step.model } : {}),
                  state: "running",
                  ...(step.currentTool ? { currentTool: step.currentTool } : {}),
                  ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
                },
              ],
        ),
  );
}

/** The steps of a run in pipeline order, with their states as ADR 0176 ("Shapes") says. */
function stepsOf(run: PipelineRun, node: (agentId: string) => GraphAgent | undefined): GraphStep[] {
  const passed = run.state === "passed";
  const ended = run.state === "failed" || run.state === "stopped";
  // A step with no turn: before the current group it is over, in it the run decides, after it nothing started.
  // A group runs as one stage and `run.stageIndex` is its first member (ADR 0178), so compare groups.
  const groups = stageGroups(run.stages);
  const groupAt = (index: number) => groups.findIndex((group) => group.includes(index));
  const current = groupAt(run.stageIndex);
  const placed = (index: number): GraphStep["state"] => {
    if (passed || groupAt(index) < current) return "done";
    if (groupAt(index) > current) return "waiting";
    return ended ? "failed" : "running";
  };
  return run.stages.flatMap((stage, index): GraphStep[] => {
    const id = `${run.id}:${index}`;
    if (stage.gates)
      return [{ id, stage: stage.name, kind: "gates", state: placed(index), gates: stage.gates }];
    const turns = run.turns.filter((turn) => turn.stageIndex === index);
    if (turns.length === 0) {
      // An agent stage without a turn has not started, even at the current stage.
      const state = placed(index);
      return [
        {
          id,
          stage: stage.name,
          kind: stage.role === "worker" ? "task" : "review",
          state: state === "running" ? "waiting" : state,
        },
      ];
    }
    return turns.map((turn) => {
      const agent = node(turn.agentId);
      return {
        id: turn.id,
        stage: stage.name,
        kind: turn.kind,
        round: turn.round,
        state: passed || turn.report ? "done" : turn.error || ended ? "failed" : "running",
        ...(agent ? { agent } : {}),
      };
    });
  });
}

function groupOf(
  run: PipelineRun,
  node: (agentId: string) => GraphAgent | undefined,
  lane?: { id: string; name: string },
): GraphGroup {
  const round = run.turns.filter((turn) => turn.stageIndex === run.stageIndex).at(-1)?.round;
  return {
    pipelineRunId: run.id,
    workspaceId: run.workspaceId,
    ...(lane ? { laneId: lane.id } : {}),
    name: run.name ?? lane?.name ?? run.pipelineId,
    state: run.state,
    // SAFETY: a run's stage index always points into its stages.
    stage: (run.stages[run.stageIndex] as { name: string }).name,
    ...(round === undefined ? {} : { round }),
    live: run.state === "running",
    steps: stepsOf(run, node),
  };
}

/** Every agent node of the trees in tree order: each root, then its groups in order, then their steps in order. */
export const nodesOf = (trees: GraphTree[]): GraphAgent[] =>
  trees.flatMap((tree) => [
    tree.root,
    ...tree.groups.flatMap((group) => group.steps.flatMap((step) => step.agent ?? [])),
  ]);

/** Every tree of the agent graph (ADR 0176, "What is in the graph"), with running helpers only. */
export function buildGraph({ agents, pipelines, runs, workspaces }: GraphSources): GraphTree[] {
  const since = new Map(agents.attention().map((entry) => [entry.agent.id, entry.since]));
  const toNode = (agent: Agent): GraphAgent => {
    const live = agents.liveState(agent.id);
    return {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      kind: agent.kind,
      role: agent.role,
      ...(agent.title === undefined ? {} : { title: agent.title }),
      status: agent.status,
      ...(agent.workingFor === undefined ? {} : { workingFor: agent.workingFor }),
      ...(live.model ? { model: live.model } : {}),
      ...(live.routedModel ? { routedModel: live.routedModel } : {}),
      // `attention()` leaves out closed agents, so a closed agent has no status time; its creation time stands in.
      since: since.get(agent.id) ?? agent.createdAt,
      helpers: helpersOf(live.children),
    };
  };

  const active = workspaces
    .list({ state: "active" })
    .filter((workspace) => !workspace.planner)
    .sort((a, b) => a.createdAt - b.createdAt);
  const activeIds = new Set(active.map((workspace) => workspace.id));
  // Every agent the graph can show is in an active workspace. Retention deletes a closed chat while its pipeline
  // turns stay, so an id may name no agent: its step shows no agent, and a run without its coordinator no tree.
  const chats = new Map(
    active.map((workspace) => [workspace.id, agents.inWorkspace(workspace.id)]),
  );
  const known = new Map([...chats.values()].flat().map((agent) => [agent.id, agent]));
  const node = (agentId: string): GraphAgent | undefined => {
    const agent = known.get(agentId);
    return agent && toNode(agent);
  };
  const base = (workspace: Workspace) => ({
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    name: workspace.name,
  });

  const trees = active.flatMap((workspace): GraphTree[] => {
    const run = runs.runOf(workspace.id);
    if (run) {
      const root = node(run.coordinatorAgentId);
      if (!root) return [];
      return [
        {
          kind: "run",
          ...base(workspace),
          runId: run.id,
          root,
          groups: run.lanes.flatMap((lane) =>
            lane.workspaceId && activeIds.has(lane.workspaceId) && lane.pipelineRunId
              ? [groupOf(pipelines.get(lane.pipelineRunId), node, lane)]
              : [],
          ),
          // The module's own rows fill these in (ADR 0176, card 4); buildGraph knows nothing about them.
          positions: {},
        },
      ];
    }
    if (runs.laneOf(workspace.id)) return [];
    const chat = (chats.get(workspace.id) ?? []).find(
      (agent) => agent.kind === "worker" && agent.active && !agents.isClosed(agent.id),
    );
    if (!chat) return [];
    // Newest first, so index 0 is the newest run, shown also when it ended.
    const shown = pipelines
      .runsOf(workspace.id)
      .filter(
        (entry, index) =>
          index === 0 || entry.state === "running" || entry.state === "waiting_user",
      );
    return [
      {
        kind: "workspace",
        ...base(workspace),
        root: toNode(chat),
        groups: shown.map((entry) => groupOf(entry, node)),
        positions: {},
      },
    ];
  });
  // One stage agent can back several steps (a task turn and its fix turns, or a reused worker in two groups).
  // Its helpers show once, on its last node; each earlier node of it shows none.
  const last = new Map(nodesOf(trees).map((entry) => [entry.agentId, entry]));
  for (const entry of nodesOf(trees)) if (last.get(entry.agentId) !== entry) entry.helpers = [];
  return trees;
}
