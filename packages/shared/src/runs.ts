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
});
export type Run = Static<typeof Run>;

export const RunList = Type.Object({ runs: Type.Array(Run) });
export type RunList = Static<typeof RunList>;

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
