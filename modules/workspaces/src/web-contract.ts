import { defineInterface } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";
import type { Tone } from "@pi-spore/ui";
import type { ComponentType } from "react";

/**
 * A section another web module adds to the workspace's right column, such as Actions or Unity. It renders its own
 * `CollapsibleSection`, so it can render nothing when it does not apply (Unity on a non-Unity project).
 */
export interface WorkspacePanel {
  id: string;
  /** Lower comes first. */
  order: number;
  component: ComponentType<{ workspace: Workspace }>;
}

/** One line of live state for a workspace row, such as the agent's status. */
export interface WorkspaceStatus {
  text: string;
  tone: Tone;
}

/**
 * A React hook that returns a status line per workspace id. It is called on every render of the list, always, so
 * it may use other hooks.
 */
export type UseWorkspaceStatus = (
  workspaces: readonly Workspace[],
) => ReadonlyMap<string, WorkspaceStatus>;

export interface WorkspaceView {
  /** Adds a section to the right column. */
  addPanel(panel: WorkspacePanel): void;
  /**
   * Sets the middle pane for a selected workspace: the chat. `chatId` comes from `#/workspaces/<id>/chats/<chat>`.
   * Only one module may set it.
   */
  setMain(component: ComponentType<{ workspace: Workspace; chatId?: string }>): void;
  /** Sets where the list gets its status lines. Only one module may set it. */
  setStatus(useStatus: UseWorkspaceStatus): void;
}

export const WorkspaceViewKey = defineInterface<WorkspaceView>("workspaces", "view");
