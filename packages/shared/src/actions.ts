import Type, { type Static } from "typebox";
import { SettingSource } from "./projects.js";

/** A named command from `[actions.<name>]` in the project file or the local override (R12, architecture 13). */
export const ActionView = Type.Object({
  name: Type.String(),
  /** An argv array, or a shell string when `shell` is true. */
  run: Type.Union([Type.String(), Type.Array(Type.String())]),
  shell: Type.Boolean(),
  exclusive: Type.Boolean(),
  description: Type.Optional(Type.String()),
  source: SettingSource,
});
export type ActionView = Static<typeof ActionView>;

export const ActionList = Type.Object({ actions: Type.Array(ActionView) });
export type ActionList = Static<typeof ActionList>;

/**
 * `queued` waits for an exclusive run in the same folder to end. `interrupted` means the server stopped while the
 * run was queued or running.
 */
export const ActionRunStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);
export type ActionRunStatus = Static<typeof ActionRunStatus>;

/** Who started a run: the user (UI, CLI), the workspace's agent (spore-bridge), the workspace lifecycle
 * (`setup` after create, `teardown` before archive), or a pipeline gate. */
export const ActionTrigger = Type.Union([
  Type.Literal("user"),
  Type.Literal("agent"),
  Type.Literal("create"),
  Type.Literal("archive"),
  Type.Literal("pipeline"),
]);
export type ActionTrigger = Static<typeof ActionTrigger>;

export const ActionRun = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  action: Type.String(),
  trigger: ActionTrigger,
  status: ActionRunStatus,
  exitCode: Type.Optional(Type.Integer()),
  signal: Type.Optional(Type.String()),
  /** Why the run did not start or end normally, such as a missing program. */
  error: Type.Optional(Type.String()),
  logPath: Type.String(),
  createdAt: Type.Integer(),
  startedAt: Type.Optional(Type.Integer()),
  endedAt: Type.Optional(Type.Integer()),
});
export type ActionRun = Static<typeof ActionRun>;

export const ActionRunList = Type.Object({ runs: Type.Array(ActionRun) });
export type ActionRunList = Static<typeof ActionRunList>;

export const StartActionRequest = Type.Object(
  { action: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type StartActionRequest = Static<typeof StartActionRequest>;

/**
 * Part of a run's log: bytes `start` to `end` of `size`. Without an offset it is the tail. To follow a run, ask again
 * from `end` until the run has ended and `end` equals `size`.
 */
export const ActionLog = Type.Object({
  run: ActionRun,
  text: Type.String(),
  start: Type.Integer(),
  end: Type.Integer(),
  size: Type.Integer(),
});
export type ActionLog = Static<typeof ActionLog>;
