import Type, { type Static } from "typebox";
import { AgentRole } from "./agents.js";

/** One plan window as the Usage screen shows it (R18.1). */
export const UsageWindow = Type.Object({
  /** `5h`, `7d`, or a length such as `60m`. */
  name: Type.String(),
  /** Share used, 0 to 1. */
  utilization: Type.Number(),
  resetsAt: Type.Optional(Type.Number()),
  seenAt: Type.Number(),
  ageMs: Type.Number(),
  /** Why the router ignores the number (R18.5). Absent when it is fresh. */
  stale: Type.Optional(Type.String()),
});
export type UsageWindow = Static<typeof UsageWindow>;

export const UsagePlan = Type.Object({
  plan: Type.String(),
  status: Type.Optional(Type.String()),
  source: Type.String(),
  seenAt: Type.Number(),
  ageMs: Type.Number(),
  windows: Type.Array(UsageWindow),
});
export type UsagePlan = Static<typeof UsagePlan>;

/** A fresh window over a threshold (R18.4). */
export const UsageWarning = Type.Object({
  plan: Type.String(),
  window: Type.String(),
  utilization: Type.Number(),
  message: Type.String(),
});
export type UsageWarning = Static<typeof UsageWarning>;

export const UsagePlansResponse = Type.Object({
  plans: Type.Array(UsagePlan),
  warnings: Type.Array(UsageWarning),
  thresholds: Type.Object({ weekly: Type.Number(), fiveHour: Type.Number() }),
  maxAgeMinutes: Type.Number(),
  /** Plan files that could not be read, with the reason. */
  errors: Type.Array(Type.String()),
});
export type UsagePlansResponse = Static<typeof UsagePlansResponse>;

/** Token use of one model by one role in one workspace, or in a plain Pi session (R18.2, R18.3). */
export const TokenUseRow = Type.Object({
  projectId: Type.Optional(Type.String()),
  projectName: Type.String(),
  /** Missing for a plain Pi session, which belongs to no workspace. */
  workspaceId: Type.Optional(Type.String()),
  workspaceName: Type.String(),
  /** The agent's role from its launch record. Missing for a plain Pi session and for one whose agent is gone. */
  role: Type.Optional(AgentRole),
  /** Seen in a plain Pi session outside pi-spore (R18.3). */
  external: Type.Boolean(),
  provider: Type.String(),
  model: Type.String(),
  /** A local model: free, whatever the session file says. */
  local: Type.Boolean(),
  requests: Type.Integer(),
  input: Type.Integer(),
  output: Type.Integer(),
  cacheRead: Type.Integer(),
  cacheWrite: Type.Integer(),
  /** Dollars from the model catalog's prices. Subscription models through claude-bridge show 0. */
  cost: Type.Number(),
});
export type TokenUseRow = Static<typeof TokenUseRow>;

export const TokenUseResponse = Type.Object({
  rows: Type.Array(TokenUseRow),
  sessions: Type.Integer(),
  /** Lines in session files that were not JSON, such as a partial last line after a crash. */
  skippedLines: Type.Integer(),
});
export type TokenUseResponse = Static<typeof TokenUseResponse>;

/** One routing decision of the router (R4.7). Other fields of the record are kept but not typed here. */
export const RoutingDecision = Type.Object({
  at: Type.Number(),
  kind: Type.String(),
  route: Type.String(),
  /** Absent in lines from before ADR 0141. */
  rung: Type.Optional(Type.Integer()),
  plan: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  reasons: Type.Array(Type.String()),
  sessionId: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
  estimate: Type.Optional(Type.Number()),
  budget: Type.Optional(Type.Number()),
  jev: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
  threshold: Type.Optional(Type.Number()),
  heavyThreshold: Type.Optional(Type.Number()),
  pressure: Type.Optional(Type.Boolean()),
  usage: Type.Optional(Type.Array(Type.String())),
});
export type RoutingDecision = Static<typeof RoutingDecision>;

export const RoutingDecisionsResponse = Type.Object({
  decisions: Type.Array(RoutingDecision),
  /** Lines of the decision file that did not parse. */
  skipped: Type.Integer(),
});
export type RoutingDecisionsResponse = Static<typeof RoutingDecisionsResponse>;

/** One tenth of the 0 to 1 range for one Jev question (ADR 0144). */
export const CalibrationBucket = Type.Object({
  from: Type.Number(),
  to: Type.Number(),
  /** Decisions whose answer to the question falls here. */
  answers: Type.Integer(),
  /** Local runs with a verdict among those decisions. */
  localOutcomes: Type.Integer(),
  passed: Type.Integer(),
  /** False under the minimum sample: too little data to read a share. */
  enough: Type.Boolean(),
});
export type CalibrationBucket = Static<typeof CalibrationBucket>;

/** What a bar between 0.1 and 0.9 would have done to the decisions Jev answered. */
export const CalibrationBar = Type.Object({
  bar: Type.Number(),
  decisions: Type.Integer(),
  /** Decisions whose cheap answers are all at or above the bar and whose heavy answers reach `heavyThreshold`. */
  wouldGoLocal: Type.Integer(),
  localOutcomes: Type.Integer(),
  passed: Type.Integer(),
  enough: Type.Boolean(),
});
export type CalibrationBar = Static<typeof CalibrationBar>;

/** Decisions on one rung that went to one place, and how the runs that followed them ended (ADR 0141). */
export const CalibrationRung = Type.Object({
  rung: Type.Integer(),
  /** `local`, else the ladder plan (`wait` when no plan had room). */
  place: Type.String(),
  decisions: Type.Integer(),
  /** Runs with a verdict that joined these decisions. */
  outcomes: Type.Integer(),
  passed: Type.Integer(),
});
export type CalibrationRung = Static<typeof CalibrationRung>;

export const CalibrationResponse = Type.Object({
  /** `router.threshold` now. */
  threshold: Type.Number(),
  /** `router.heavyThreshold` now. */
  heavyThreshold: Type.Number(),
  minSample: Type.Integer(),
  /** Router decisions with Jev answers. */
  decisions: Type.Integer(),
  /** Local decisions that a pipeline run with a verdict joined. */
  outcomes: Type.Integer(),
  buckets: Type.Object({
    bounded: Type.Array(CalibrationBucket),
    explicit: Type.Array(CalibrationBucket),
    visual: Type.Array(CalibrationBucket),
    straightforward: Type.Array(CalibrationBucket),
    foundational: Type.Array(CalibrationBucket),
    design: Type.Array(CalibrationBucket),
  }),
  bars: Type.Array(CalibrationBar),
  rungs: Type.Array(CalibrationRung),
  /** The lowest bar with enough local outcomes and at least 90% passed. Absent when none qualifies. */
  suggestedBar: Type.Optional(Type.Number()),
  /** Lines of the decision file that did not parse. */
  skipped: Type.Integer(),
});
export type CalibrationResponse = Static<typeof CalibrationResponse>;
