import { defineInterface } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";

/** Runs before a workspace stops being active, so work in it can stop first. A throw cancels the change. */
export type LeaveListener = (workspace: Workspace, next: "parked" | "archived") => Promise<void>;

export interface Workspaces {
  /** Throws ApiError 404 if there is no such workspace. */
  get(id: string): Workspace;
  beforeLeaveActive(listener: LeaveListener): void;
}

export const WorkspacesKey = defineInterface<Workspaces>("workspaces", "workspaces");
