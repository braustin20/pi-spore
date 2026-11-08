import type { Workspace } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { ago, groupWorkspaces, reduceWorkspaceList } from "./list.js";

const workspace = (id: string, state: Workspace["state"], updatedAt: number, projectId = "p1") =>
  ({
    id,
    projectId,
    name: id,
    slug: id,
    isolation: "new",
    path: `/tmp/${id}`,
    state,
    createdAt: 0,
    updatedAt,
  }) satisfies Workspace;

describe("groupWorkspaces", () => {
  const list = [
    workspace("old-active", "active", 1),
    workspace("parked", "parked", 5),
    workspace("new-active", "active", 9),
    workspace("archived", "archived", 7),
    workspace("other-project", "active", 3, "p2"),
  ];
  const ids = (groups: ReturnType<typeof groupWorkspaces>) =>
    groups.map((group) => [group.state, group.workspaces.map((each) => each.id)]);

  it("puts active first, then parked, newest first, and hides archived", () => {
    expect(ids(groupWorkspaces(list, { showArchived: false }))).toEqual([
      ["active", ["new-active", "other-project", "old-active"]],
      ["parked", ["parked"]],
    ]);
  });

  it("shows archived last when asked", () => {
    expect(ids(groupWorkspaces(list, { showArchived: true })).at(-1)).toEqual([
      "archived",
      ["archived"],
    ]);
  });

  it("filters by project and leaves out empty groups", () => {
    expect(ids(groupWorkspaces(list, { showArchived: false, projectId: "p2" }))).toEqual([
      ["active", ["other-project"]],
    ]);
  });
});

describe("ago", () => {
  it("rounds down to the largest unit", () => {
    const now = 10 * 86_400_000;
    expect(ago(now - 30_000, now)).toBe("now");
    expect(ago(now - 5 * 60_000, now)).toBe("5m");
    expect(ago(now - 3 * 3_600_000 - 59 * 60_000, now)).toBe("3h");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d");
  });
});

describe("reduceWorkspaceList", () => {
  it("drops a workspace on a removed event", () => {
    const kept = workspace("kept", "active", 1);
    const gone = workspace("gone", "archived", 2);
    expect(reduceWorkspaceList([kept, gone], { type: "removed", id: "gone" })).toEqual([kept]);
  });

  it("ignores a removed event for an unknown id", () => {
    const kept = workspace("kept", "active", 1);
    expect(reduceWorkspaceList([kept], { type: "removed", id: "other" })).toEqual([kept]);
  });
});
