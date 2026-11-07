import { defineInterface } from "@pi-spore/module-api";
import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  Project,
  Workspace,
} from "@pi-spore/shared";
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

/**
 * A tab another web module adds to the right column's tab bar, after Details, such as Terminals. Its component is
 * mounted only while the tab is open, and again for each workspace.
 */
export interface WorkspaceTab {
  id: string;
  title: string;
  /** Lower comes first. */
  order: number;
  /** The column widens while this tab is open, for content such as a terminal. */
  wide?: boolean;
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

/** The "Start a workspace" form, for other modules that start workspaces, such as a kanban card. */
export interface CreateWorkspaceFormProps {
  projects: readonly Project[];
  /** The project chosen first. */
  projectId?: string | undefined;
  /** Only `projectId` can be chosen. */
  lockProject?: boolean;
  /** The first value of the name field. */
  name?: string;
  title?: string;
  /** Sends the request. Default: `POST /api/workspaces`. */
  submit?: (request: CreateWorkspaceRequest) => Promise<CreateWorkspaceResponse>;
  onCreated: (result: CreateWorkspaceResponse) => void;
}

export interface WorkspaceView {
  /** Adds a section to the right column. */
  addPanel(panel: WorkspacePanel): void;
  /** Adds a tab to the right column. */
  addTab(tab: WorkspaceTab): void;
  /**
   * Sets the middle pane for a selected workspace: the chat. `chatId` comes from `#/workspaces/<id>/chats/<chat>`.
   * Only one module may set it.
   */
  setMain(component: ComponentType<{ workspace: Workspace; chatId?: string }>): void;
  /** Sets where the list gets its status lines. Only one module may set it. */
  setStatus(useStatus: UseWorkspaceStatus): void;
  /** The form the workspace view shows to start a workspace. */
  CreateForm: ComponentType<CreateWorkspaceFormProps>;
}

export const WorkspaceViewKey = defineInterface<WorkspaceView>("workspaces", "view");
