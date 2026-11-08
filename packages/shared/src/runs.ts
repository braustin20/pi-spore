import Type, { type Static } from "typebox";
import { ModelRef } from "./agents.js";

/** Where a lane is (R7.1, ADR 0007). `approval`: its model waits for the user. `waiting`: its wave has not come. */
export const LaneState = Type.Union([
  Type.Literal("approval"),
  Type.Literal("waiting"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("declined"),
  Type.Literal("merging"),
  Type.Literal("merged"),
]);
export type LaneState = Static<typeof LaneState>;

export const Lane = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  name: Type.String(),
  wave: Type.Integer({ minimum: 1 }),
  dependsOn: Type.Array(Type.String()),
  /** The artifact path of the brief, in the run workspace. */
  brief: Type.String(),
  pipeline: Type.String(),
  model: Type.Optional(ModelRef),
  state: LaneState,
  /** The lane's own workspace, once it has one. */
  workspaceId: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
});
export type Lane = Static<typeof Lane>;

/** A question a lane agent asked its coordinator (R7.5, ADR 0008). */
export const RunQuestion = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  laneId: Type.String(),
  /** The lane agent that asked, and gets the answer. */
  agentId: Type.String(),
  question: Type.String(),
  answer: Type.Optional(Type.String()),
  state: Type.Union([Type.Literal("open"), Type.Literal("answered")]),
  createdAt: Type.Integer(),
});
export type RunQuestion = Static<typeof RunQuestion>;

export const Run = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  /** The run workspace, on the run's line. */
  workspaceId: Type.String(),
  line: Type.String(),
  base: Type.String(),
  /** Actions that must pass before a lane's merge is committed. */
  gates: Type.Array(Type.String()),
  coordinatorAgentId: Type.String(),
  createdAt: Type.Integer(),
  lanes: Type.Array(Lane),
  /** The questions of its lanes that wait for an answer. */
  questions: Type.Array(RunQuestion),
});
export type Run = Static<typeof Run>;

export const RunList = Type.Object({ runs: Type.Array(Run) });
export type RunList = Static<typeof RunList>;

/** The only event of topic `runs:list`: every run, newest first. */
export const RunEvent = Type.Object({
  type: Type.Literal("runs"),
  runs: Type.Array(Run),
});
export type RunEvent = Static<typeof RunEvent>;

export const CreateRunRequest = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    /** Default: the main copy's current line. */
    base: Type.Optional(Type.String({ minLength: 1 })),
    /** Default: `check` and `test`. */
    gates: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  },
  { additionalProperties: false },
);
export type CreateRunRequest = Static<typeof CreateRunRequest>;

export const StartLaneRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    /** The artifact path of the brief, in the run workspace. */
    brief: Type.String({ minLength: 1 }),
    wave: Type.Integer({ minimum: 1 }),
    /** Lane ids of the same run. */
    dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** Default: `default`. */
    pipeline: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(ModelRef),
  },
  { additionalProperties: false },
);
export type StartLaneRequest = Static<typeof StartLaneRequest>;

export const ReviseLaneRequest = Type.Object(
  { laneId: Type.String({ minLength: 1 }), brief: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type ReviseLaneRequest = Static<typeof ReviseLaneRequest>;

export const MergeLaneRequest = Type.Object(
  { laneId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type MergeLaneRequest = Static<typeof MergeLaneRequest>;

export const AskCoordinatorRequest = Type.Object(
  { question: Type.String({ minLength: 1, maxLength: 4_000 }) },
  { additionalProperties: false },
);
export type AskCoordinatorRequest = Static<typeof AskCoordinatorRequest>;

export const AnswerLaneRequest = Type.Object(
  {
    questionId: Type.String({ minLength: 1 }),
    answer: Type.String({ minLength: 1, maxLength: 8_000 }),
  },
  { additionalProperties: false },
);
export type AnswerLaneRequest = Static<typeof AnswerLaneRequest>;
