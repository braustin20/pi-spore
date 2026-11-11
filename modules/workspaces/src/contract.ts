import { defineInterface } from "@pi-spore/module-api";
import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  StepReport,
  Workspace,
  WorkspaceState,
} from "@pi-spore/shared";

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

/** Runs after a parked workspace is active again, so work that waited for it can go on. */
export type ResumeListener = (workspace: Workspace) => void;

/**
 * Runs after a workspace moved to another state (park, resume, archive), with the stored workspace. The change is
 * done by then: a throw is logged and does not undo it.
 */
export type StateChangeListener = (workspace: Workspace, previous: WorkspaceState) => void;

/**
 * Runs in each retention sweep, with the cutoff time in ms. A module deletes its own data older than the cutoff that
 * is not tied to an archived workspace. A throw is logged and the other listeners still run.
 */
export type RetentionListener = (cutoff: number) => Promise<void>;

/**
 * Runs before an archived workspace past the retention limit is deleted. A module deletes what it holds for that
 * workspace. It must be safe to run again: a throw is logged, the workspace keeps its row, and the next sweep tries
 * again.
 */
export type DeleteListener = (workspace: Workspace) => Promise<void>;

export interface Workspaces {
  /** Throws ApiError 404 if there is no such workspace. */
  get(id: string): Workspace;
  list(filter?: { projectId?: string; state?: WorkspaceState }): Workspace[];
  /**
   * Creates a workspace as `POST /api/workspaces` does. Throws ApiError on a bad request. The settings in the
   * request count as source `workspace`, or `run` when `overrideSource` says so (R17.2).
   */
  create(
    request: CreateWorkspaceRequest,
    options?: { overrideSource?: "run" },
  ): Promise<CreateWorkspaceResponse>;
  /**
   * The project's planner workspace, as `POST /api/workspaces/planner` gives it: found, or made in place on the first
   * call (ADR 0174). Throws ApiError as `create` does.
   */
  planner(projectId: string): Promise<Workspace>;
  beforeLeaveActive(listener: LeaveListener): void;
  afterCopyCreated(listener: CopyCreatedListener): void;
  beforeRemoveCopy(listener: RemoveCopyListener): void;
  afterResume(listener: ResumeListener): void;
  afterStateChange(listener: StateChangeListener): void;
  onRetention(listener: RetentionListener): void;
  beforeDeleteWorkspace(listener: DeleteListener): void;
}

export const WorkspacesKey = defineInterface<Workspaces>("workspaces", "workspaces");
