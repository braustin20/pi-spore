import Type, { type Static } from "typebox";
import { AgentRole, AgentStatus, ChatKind } from "./agents.js";
import { PipelineRunState } from "./pipelines.js";

/** A running step of an agent's background child run (ADR 0176). The id is `<child run id>:<step index>`. */
export const GraphHelper = Type.Object({
  id: Type.String(),
  agent: Type.Optional(Type.String()),
  /** `provider/id`. */
  model: Type.Optional(Type.String()),
  /** `done` and `failed` only in the one topic event after the helper ended. */
  state: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  currentTool: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.Integer()),
});
export type GraphHelper = Static<typeof GraphHelper>;

/** One agent of the graph. Models are `provider/id`. */
export const GraphAgent = Type.Object({
  agentId: Type.String(),
  workspaceId: Type.String(),
  kind: ChatKind,
  role: AgentRole,
  title: Type.Optional(Type.String()),
  status: AgentStatus,
  workingFor: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  /** The physical model of its newest answer, when it differs from `model`. */
  routedModel: Type.Optional(Type.String()),
  /** When it entered its status. */
  since: Type.Integer(),
  helpers: Type.Array(GraphHelper),
});
export type GraphAgent = Static<typeof GraphAgent>;

/** One node of a pipeline run's group. The id is the turn id, or `<pipeline run id>:<stage index>` without a turn. */
export const GraphStep = Type.Object({
  id: Type.String(),
  stage: Type.String(),
  kind: Type.Union([
    Type.Literal("task"),
    Type.Literal("review"),
    Type.Literal("fix"),
    Type.Literal("gates"),
  ]),
  round: Type.Optional(Type.Integer()),
  state: Type.Union([
    Type.Literal("waiting"),
    Type.Literal("running"),
    Type.Literal("done"),
    Type.Literal("failed"),
  ]),
  gates: Type.Optional(Type.Array(Type.String())),
  agent: Type.Optional(GraphAgent),
  /** The step runs next to the step before it, in one round of a parallel group (ADR 0178). */
  beside: Type.Optional(Type.Literal(true)),
  /** How the step ended, or why it waits (ADR 0188). A failed step says so with `state` instead. */
  outcome: Type.Optional(
    Type.Union([
      Type.Literal("approved"),
      Type.Literal("revise"),
      Type.Literal("reported"),
      Type.Literal("passed"),
      Type.Literal("blocked"),
      Type.Literal("asking"),
    ]),
  ),
  /** How many findings a `revise` report held, so only with `outcome: "revise"`, and only when there are any. */
  findings: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Why a `blocked` step waits: the run's blocked message. Only with `outcome: "blocked"`. */
  note: Type.Optional(Type.String()),
});
export type GraphStep = Static<typeof GraphStep>;

/** One pipeline run of a tree: a lane's run, or a run of a workspace. */
export const GraphGroup = Type.Object({
  pipelineRunId: Type.String(),
  workspaceId: Type.String(),
  laneId: Type.Optional(Type.String()),
  /** The slice name, else the lane name, else the pipeline id. */
  name: Type.String(),
  state: PipelineRunState,
  /** The current stage's name. */
  stage: Type.String(),
  round: Type.Optional(Type.Integer()),
  /** True while the run is `running`. */
  live: Type.Boolean(),
  /** While the run merges this lane (ADR 0150): the merge step, such as `gate test`, else `merging`. */
  merging: Type.Optional(Type.String()),
  steps: Type.Array(GraphStep),
});
export type GraphGroup = Static<typeof GraphGroup>;

/** A place on the canvas, in px. */
export const GraphPosition = Type.Object({ x: Type.Number(), y: Type.Number() });
export type GraphPosition = Static<typeof GraphPosition>;

/** A run's coordinator with its lanes, or a workspace's worker chat with its pipeline runs. */
export const GraphTree = Type.Object({
  kind: Type.Union([Type.Literal("run"), Type.Literal("workspace")]),
  workspaceId: Type.String(),
  projectId: Type.String(),
  /** The workspace's name. */
  name: Type.String(),
  runId: Type.Optional(Type.String()),
  root: GraphAgent,
  groups: Type.Array(GraphGroup),
  /**
   * Where the user dragged each node, by node id (`treeNodeId`, `groupNodeId`, `stepNodeId`); empty when nobody
   * dragged it. A tree's place is absolute; a step's is relative to its group, so a moved tree keeps its children
   * in place.
   */
  positions: Type.Record(Type.String(), GraphPosition),
});
export type GraphTree = Static<typeof GraphTree>;

/** `PUT /api/agent-graph/positions`: save where the user dropped one node of the current graph. */
export const SavePositionRequest = Type.Object({
  /** The canvas node id: `tree:<workspace id>`, `group:<pipeline run id>`, or `step:<step id>`. */
  node: Type.String({ minLength: 1 }),
  x: Type.Number(),
  y: Type.Number(),
});
export type SavePositionRequest = Static<typeof SavePositionRequest>;

/** The canvas node ids, the same in the layout and in the saved positions. Helpers have none: they are never saved. */
export const treeNodeId = (tree: GraphTree) => `tree:${tree.workspaceId}`;
export const groupNodeId = (group: GraphGroup) => `group:${group.pipelineRunId}`;
export const stepNodeId = (step: GraphStep) => `step:${step.id}`;

/** `GET /api/agent-graph`: every tree, by workspace creation time, oldest first. */
export const AgentGraph = Type.Object({ trees: Type.Array(GraphTree) });
export type AgentGraph = Static<typeof AgentGraph>;

/** The only event of topic `agent-graph:trees`: the whole graph again. */
export const AgentGraphEvent = Type.Object({
  type: Type.Literal("graph"),
  trees: Type.Array(GraphTree),
});
export type AgentGraphEvent = Static<typeof AgentGraphEvent>;
