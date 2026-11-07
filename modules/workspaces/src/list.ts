import type { Workspace, WorkspaceState } from "@pi-spore/shared";

export interface WorkspaceGroup {
  state: WorkspaceState;
  label: string;
  workspaces: Workspace[];
}

const GROUPS: readonly { state: WorkspaceState; label: string }[] = [
  { state: "active", label: "Active" },
  { state: "parked", label: "Parked" },
  { state: "archived", label: "Archived" },
];

/**
 * The list column's groups: active, then parked, then archived when asked for. Newest activity first in each group.
 * Empty groups are left out.
 */
export function groupWorkspaces(
  workspaces: readonly Workspace[],
  options: { showArchived: boolean; projectId?: string | undefined },
): WorkspaceGroup[] {
  return GROUPS.filter((group) => options.showArchived || group.state !== "archived")
    .map((group) => ({
      ...group,
      workspaces: workspaces
        .filter(
          (workspace) =>
            workspace.state === group.state &&
            (options.projectId === undefined || workspace.projectId === options.projectId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter((group) => group.workspaces.length > 0);
}

/** A short age such as `now`, `5m`, `3h`, or `2d`. */
export function ago(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
