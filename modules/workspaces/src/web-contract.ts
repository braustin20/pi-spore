import { defineInterface } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";
import type { ComponentType } from "react";

/** A section another web module adds to the workspace page, such as Actions or Unity. */
export interface WorkspacePanel {
  id: string;
  /** Lower comes first. */
  order: number;
  component: ComponentType<{ workspace: Workspace }>;
}

export interface WorkspacePanels {
  add(panel: WorkspacePanel): void;
}

export const WorkspacePanelsKey = defineInterface<WorkspacePanels>("workspaces", "panels");
