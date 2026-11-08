import Type, { type Static } from "typebox";
import { ModelRef, StageRole } from "./agents.js";

/** Ids and stage names of a pipeline file (R6.2). */
export const PIPELINE_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";
const PipelineName = Type.String({ pattern: PIPELINE_ID_PATTERN });

/**
 * One `[[stage]]` of a pipeline file, as written. A stage is an agent stage (`role`) or a gate stage (`gates`); the
 * keys of the other kind are refused when the file is read. Defaults (`rounds` 1, `fix_passes` 0) apply when the
 * stage runs.
 */
export const PipelineStage = Type.Object(
  {
    name: PipelineName,
    role: Type.Optional(StageRole),
    model: Type.Optional(ModelRef),
    /** Only `route` is built: the model `spore/auto` (R4.9). */
    tier: Type.Optional(Type.String()),
    rounds: Type.Optional(Type.Integer({ minimum: 1 })),
    fix_passes: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1)])),
    early_stop: Type.Optional(Type.Literal("jev")),
    min_strength_over: Type.Optional(PipelineName),
    gates: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    fail_first: Type.Optional(Type.Literal("artifact")),
  },
  { additionalProperties: false },
);
export type PipelineStage = Static<typeof PipelineStage>;

/** A pipeline file (`<id>.toml`) after TOML parsing. */
export const PipelineFile = Type.Object(
  { id: PipelineName, stage: Type.Array(PipelineStage, { minItems: 1 }) },
  { additionalProperties: false },
);
export type PipelineFile = Static<typeof PipelineFile>;

export const PipelineSource = Type.Union([
  Type.Literal("user"),
  Type.Literal("project"),
  Type.Literal("built-in"),
]);
export type PipelineSource = Static<typeof PipelineSource>;

/** A pipeline a workspace can start. A bad file has `error` in place of `hash` and `stages`. */
export const PipelineView = Type.Object({
  id: Type.String(),
  source: PipelineSource,
  path: Type.Optional(Type.String()),
  /** SHA-256 of the file's bytes, in hex. */
  hash: Type.Optional(Type.String()),
  stages: Type.Optional(Type.Array(PipelineStage)),
  error: Type.Optional(Type.String()),
});
export type PipelineView = Static<typeof PipelineView>;

export const PipelineList = Type.Object({ pipelines: Type.Array(PipelineView) });
export type PipelineList = Static<typeof PipelineList>;

export const StartPipelineRequest = Type.Object(
  { pipeline: Type.String(), brief: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type StartPipelineRequest = Static<typeof StartPipelineRequest>;

const Finding = Type.Object(
  {
    severity: Type.Union([
      Type.Literal("blocking"),
      Type.Literal("important"),
      Type.Literal("minor"),
    ]),
    title: Type.String({ minLength: 1 }),
    detail: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** A test the worker added, and the workspace artifact path that proves it failed before the code (ADR 0016). */
export const TestProof = Type.Object(
  { name: Type.String({ minLength: 1 }), proof: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type TestProof = Static<typeof TestProof>;

/** What a stage agent sends through the `report` tool, and the only way its turn ends. */
export const StageReport = Type.Object(
  {
    /** The turn id the prompt names. */
    turn: Type.String(),
    summary: Type.String({ minLength: 1, maxLength: 20_000 }),
    /** Required for reviewer roles, refused for the worker. */
    verdict: Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("revise")])),
    findings: Type.Optional(Type.Array(Finding)),
    /** Worker only. */
    tests: Type.Optional(Type.Array(TestProof)),
    /** Reviewer only: Jev's answer on stopping early. */
    earlyStop: Type.Optional(
      Type.Object(
        {
          stop: Type.Boolean(),
          probability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          error: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type StageReport = Static<typeof StageReport>;

export const PipelineTurnKind = Type.Union([
  Type.Literal("task"),
  Type.Literal("fix"),
  Type.Literal("review"),
]);
export type PipelineTurnKind = Static<typeof PipelineTurnKind>;

/** One prompt to a stage agent and the report that answered it. */
export const PipelineTurn = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  stageIndex: Type.Integer(),
  stage: Type.String(),
  round: Type.Integer(),
  kind: PipelineTurnKind,
  role: StageRole,
  agentId: Type.String(),
  report: Type.Optional(StageReport),
  /** The router's newest decision for a worker turn's agent (R4.7). Absent for a stage on a fixed model. */
  routing: Type.Optional(
    Type.Object({
      route: Type.Union([
        Type.Literal("local"),
        Type.Literal("cloud"),
        Type.Literal("spill"),
        Type.Literal("wait"),
      ]),
      model: Type.Optional(Type.String()),
      reasons: Type.Array(Type.String()),
    }),
  ),
  createdAt: Type.Integer(),
  reportedAt: Type.Optional(Type.Integer()),
});
export type PipelineTurn = Static<typeof PipelineTurn>;

export const PipelineRunState = Type.Union([
  Type.Literal("running"),
  Type.Literal("waiting_user"),
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
]);
export type PipelineRunState = Static<typeof PipelineRunState>;

/** One execution of a pipeline on a workspace. `stages` and `hash` are those of the file when the run started. */
export const PipelineRun = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  pipelineId: Type.String(),
  source: PipelineSource,
  path: Type.Optional(Type.String()),
  hash: Type.String(),
  stages: Type.Array(PipelineStage),
  brief: Type.String(),
  /** The orchestrator chat that started the run. */
  askingAgentId: Type.String(),
  workerAgentId: Type.Optional(Type.String()),
  state: PipelineRunState,
  stageIndex: Type.Integer(),
  /** Why the run failed, stopped, or waits. */
  message: Type.Optional(Type.String()),
  /** Why a running run does not move: the error of its stage job, which waits for a fix and a retry. */
  blocked: Type.Optional(Type.String()),
  /** Every test a worker reported, with its proof path. */
  tests: Type.Array(TestProof),
  turns: Type.Array(PipelineTurn),
  createdAt: Type.Integer(),
  endedAt: Type.Optional(Type.Integer()),
});
export type PipelineRun = Static<typeof PipelineRun>;

export const PipelineRunList = Type.Object({ runs: Type.Array(PipelineRun) });
export type PipelineRunList = Static<typeof PipelineRunList>;

/** The only event of topic `pipelines:<workspace id>`: the workspace's runs, newest first. */
export const PipelineEvent = Type.Object({
  type: Type.Literal("runs"),
  runs: Type.Array(PipelineRun),
});
export type PipelineEvent = Static<typeof PipelineEvent>;
