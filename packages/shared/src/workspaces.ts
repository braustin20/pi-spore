import Type, { type Static } from "typebox";
import { SettingsOverrideValues } from "./projects.js";

/**
 * How a workspace is separated from the project's main copy. Neutral words, so non-Git providers fit (ADR 0005):
 * `new` makes a new isolated copy (Git: a worktree on a new branch; folder: a scratch copy), `existing` checks out
 * an existing line (Git: a branch) in a new worktree, and `in-place` works in the project folder itself.
 */
export const Isolation = Type.Union([
  Type.Literal("new"),
  Type.Literal("existing"),
  Type.Literal("in-place"),
]);
export type Isolation = Static<typeof Isolation>;

export const WorkspaceState = Type.Union([
  Type.Literal("active"),
  Type.Literal("parked"),
  Type.Literal("archived"),
]);
export type WorkspaceState = Static<typeof WorkspaceState>;

export const Workspace = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  isolation: Isolation,
  path: Type.String(),
  /** Git: the branch the workspace works on. */
  line: Type.Optional(Type.String()),
  /**
   * Git: the branch or commit a new branch started from, for "changes since base" and the PR base. Missing for
   * workspaces made before it was recorded, and for existing-branch and in-place work.
   */
  base: Type.Optional(Type.String()),
  state: WorkspaceState,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type Workspace = Static<typeof Workspace>;

export const WorkspaceList = Type.Object({ workspaces: Type.Array(Workspace) });
export type WorkspaceList = Static<typeof WorkspaceList>;

export const CreateWorkspaceRequest = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    isolation: Isolation,
    /** For `existing`: the line to check out. */
    line: Type.Optional(Type.String({ minLength: 1 })),
    /** For `new`: the line to start from. Default: the main copy's current line. For `existing`: recorded as the base. */
    base: Type.Optional(Type.String({ minLength: 1 })),
    /** The settings override of this workspace (R17.2). */
    settings: Type.Optional(SettingsOverrideValues),
  },
  { additionalProperties: false },
);
export type CreateWorkspaceRequest = Static<typeof CreateWorkspaceRequest>;

/** The result of a step another module ran around a copy, such as the `setup` action (R2.7). */
export const StepReport = Type.Object({
  name: Type.String(),
  ok: Type.Boolean(),
  message: Type.String(),
  runId: Type.Optional(Type.String()),
  logPath: Type.Optional(Type.String()),
});
export type StepReport = Static<typeof StepReport>;

export const CreateWorkspaceResponse = Type.Object({
  workspace: Workspace,
  /** Gitignored files copied into the new copy (R2.6). */
  copied: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
  /** Steps that ran after the copy was made. A failed one leaves the workspace in place. */
  steps: Type.Array(StepReport),
});
export type CreateWorkspaceResponse = Static<typeof CreateWorkspaceResponse>;

export const RenameWorkspaceRequest = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);
export type RenameWorkspaceRequest = Static<typeof RenameWorkspaceRequest>;

export const ArchiveWorkspaceRequest = Type.Object(
  {
    /** Remove the copy even with uncommitted work in it, or after a failed step such as `teardown`. */
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ArchiveWorkspaceRequest = Static<typeof ArchiveWorkspaceRequest>;

export const ArchiveWorkspaceResponse = Type.Object({
  workspace: Workspace,
  /** Steps that ran before the copy was removed. */
  steps: Type.Array(StepReport),
});
export type ArchiveWorkspaceResponse = Static<typeof ArchiveWorkspaceResponse>;
