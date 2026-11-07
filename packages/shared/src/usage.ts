import Type, { type Static } from "typebox";

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

/** Token use of one model in one workspace (R18.2). */
export const TokenUseRow = Type.Object({
  projectId: Type.Optional(Type.String()),
  projectName: Type.String(),
  workspaceId: Type.String(),
  workspaceName: Type.String(),
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
  model: Type.Optional(Type.String()),
  reasons: Type.Array(Type.String()),
  sessionId: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
  estimate: Type.Optional(Type.Number()),
  budget: Type.Optional(Type.Number()),
  jev: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
  threshold: Type.Optional(Type.Number()),
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
