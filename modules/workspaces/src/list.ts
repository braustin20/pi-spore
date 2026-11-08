import { parse, Workspace, type WorkspaceState } from "@pi-spore/shared";
import Type from "typebox";

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

const ListEvent = Type.Union([
  Type.Object({ type: Type.Literal("snapshot"), workspaces: Type.Array(Workspace) }),
  Type.Object({ type: Type.Literal("workspace"), workspace: Workspace }),
]);

/** Applies one `workspaces:list` event. Workspaces are never deleted, so there is no removal event. */
export function reduceWorkspaceList(workspaces: Workspace[], raw: unknown): Workspace[] {
  const event = parse(ListEvent, raw, "workspace list event");
  if (event.type === "snapshot") return event.workspaces;
  const { workspace } = event;
  if (!workspaces.some((existing) => existing.id === workspace.id))
    return [workspace, ...workspaces];
  return workspaces.map((existing) => (existing.id === workspace.id ? workspace : existing));
}
