import { defineInterface } from "@pi-spore/module-api";
import type { StepReport, Workspace, WorkspaceState } from "@pi-spore/shared";

/** Runs before a workspace stops being active, so work in it can stop first. A throw cancels the change. */
export type LeaveListener = (workspace: Workspace, next: "parked" | "archived") => Promise<void>;

/**
 * Runs after a new copy is made and its copy list is done (R2.7), with the workspace already stored. The report is
 * shown in the create response; a failed step keeps the workspace.
 */
export type CopyCreatedListener = (workspace: Workspace) => Promise<StepReport | undefined>;

/**
 * Runs on archive before the copy is removed. A failed report stops the archive unless it is forced. A throw stops
 * it even when forced.
 */
export type RemoveCopyListener = (
  workspace: Workspace,
  options: { force: boolean },
) => Promise<StepReport | undefined>;

export interface Workspaces {
  /** Throws ApiError 404 if there is no such workspace. */
  get(id: string): Workspace;
  list(filter?: { projectId?: string; state?: WorkspaceState }): Workspace[];
  beforeLeaveActive(listener: LeaveListener): void;
  afterCopyCreated(listener: CopyCreatedListener): void;
  beforeRemoveCopy(listener: RemoveCopyListener): void;
}

export const WorkspacesKey = defineInterface<Workspaces>("workspaces", "workspaces");
