import type { Workspace } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { ago, groupByProject, groupWorkspaces, reduceWorkspaceList } from "./list.js";

const workspace = (id: string, state: Workspace["state"], updatedAt: number, projectId = "p1") =>
  ({
    id,
    projectId,
    name: id,
    slug: id,
    isolation: "new",
    planner: false,
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

  it("leaves out planner workspaces", () => {
    const planner = { ...workspace("plan", "active", 99), planner: true };
    expect(ids(groupWorkspaces([...list, planner], { showArchived: true }))[0]).toEqual([
      "active",
      ["new-active", "other-project", "old-active"],
    ]);
  });

  it("filters by project and leaves out empty groups", () => {
    expect(ids(groupWorkspaces(list, { showArchived: false, projectId: "p2" }))).toEqual([
      ["active", ["other-project"]],
    ]);
  });
});

describe("groupByProject", () => {
  const projects = [
    { id: "p1", name: "Zeta" },
    { id: "p2", name: "Alpha" },
    { id: "p3", name: "Empty" },
  ];
  const list = [
    workspace("z-old", "active", 1),
    workspace("z-parked", "parked", 5),
    workspace("z-new", "active", 9),
    workspace("z-archived", "archived", 7),
    workspace("a-active", "active", 3, "p2"),
    workspace("e-archived", "archived", 4, "p3"),
  ];
  const shape = (groups: ReturnType<typeof groupByProject>) =>
    groups.map((group) => [
      group.name,
      group.divider,
      group.parts.map((part) => [part.state, part.workspaces.map((each) => each.id)]),
    ]);

  it("gives one group per project, sorted by name, with dividers", () => {
    expect(shape(groupByProject(list, projects, { showArchived: false }))).toEqual([
      ["Alpha", true, [["active", ["a-active"]]]],
      ["Empty", true, []],
      [
        "Zeta",
        true,
        [
          ["active", ["z-new", "z-old"]],
          ["parked", ["z-parked"]],
        ],
      ],
    ]);
  });

  it("keeps active, parked, then archived inside a project", () => {
    const zeta = groupByProject(list, projects, { showArchived: true }).find(
      (group) => group.projectId === "p1",
    );
    expect(zeta?.parts.map((part) => [part.state, part.workspaces.map((each) => each.id)])).toEqual(
      [
        ["active", ["z-new", "z-old"]],
        ["parked", ["z-parked"]],
        ["archived", ["z-archived"]],
      ],
    );
  });

  it("keeps a project with nothing to show, for its Plan entry", () => {
    const groups = groupByProject(list, projects, { showArchived: false });
    expect(groups.map((group) => [group.projectId, group.parts.length])).toEqual([
      ["p2", 1],
      ["p3", 0],
      ["p1", 2],
    ]);
  });

  it("gives a project with no workspaces a group", () => {
    expect(
      groupByProject([], projects, { showArchived: true }).map((group) => group.projectId),
    ).toEqual(["p2", "p3", "p1"]);
  });

  it("keeps the visible workspaces of a removed project, with no Plan entry", () => {
    const gone = [
      workspace("g-active", "active", 2, "gone"),
      { ...workspace("g-plan", "active", 3, "gone"), planner: true },
      workspace("g-archived", "archived", 1, "old"),
    ];
    const groups = groupByProject([...list, ...gone], projects, { showArchived: false });
    const removed = groups.find((group) => group.projectId === "gone");
    expect(removed?.plan).toBe(false);
    expect(removed?.planner).toBeUndefined();
    expect(removed?.parts.map((part) => part.workspaces.map((each) => each.id))).toEqual([
      ["g-active"],
    ]);
    expect(groups.some((group) => group.projectId === "old")).toBe(false);
    expect(groups.filter((group) => group.plan).map((group) => group.projectId)).toEqual([
      "p2",
      "p3",
      "p1",
    ]);
  });

  it("puts a project's planner workspace on its group, not in its parts", () => {
    const planner = { ...workspace("z-plan", "active", 99), planner: true };
    const groups = groupByProject([...list, planner], projects, { showArchived: true });
    expect(groups.find((group) => group.projectId === "p1")?.planner?.id).toBe("z-plan");
    expect(groups.find((group) => group.projectId === "p2")?.planner).toBeUndefined();
    const ids = groups.flatMap((group) =>
      group.parts.flatMap((part) => part.workspaces.map((each) => each.id)),
    );
    expect(ids).not.toContain("z-plan");
  });

  it("shows no divider for a single project", () => {
    expect(shape(groupByProject(list, projects, { showArchived: false, projectId: "p2" }))).toEqual(
      [["Alpha", false, [["active", ["a-active"]]]]],
    );
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
