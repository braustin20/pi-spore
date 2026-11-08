import type { Card } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import {
  byColumn,
  dropIndex,
  dueState,
  filterCards,
  labelsOf,
  localDay,
  stepTarget,
} from "./board.js";

const card = (id: string, fields: Partial<Card> = {}): Card => ({
  id,
  title: id,
  body: "",
  labels: [],
  column: "backlog",
  position: 0,
  blockedBy: [],
  blocked: false,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

describe("board helpers", () => {
  it("formats the local day", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("marks overdue and due-today cards, but not done ones", () => {
    expect(dueState(card("a", { due: "2026-11-06" }), "2026-11-07")).toBe("overdue");
    expect(dueState(card("a", { due: "2026-11-07" }), "2026-11-07")).toBe("today");
    expect(dueState(card("a", { due: "2026-11-08" }), "2026-11-07")).toBeUndefined();
    expect(
      dueState(card("a", { due: "2026-11-06", column: "done" }), "2026-11-07"),
    ).toBeUndefined();
    expect(dueState(card("a"), "2026-11-07")).toBeUndefined();
  });

  it("hides archived cards unless asked to show them", () => {
    const cards = [card("a"), card("b", { archivedAt: 5 })];
    const ids = (showArchived: boolean) =>
      filterCards(cards, { projectId: "", label: "", showArchived }).map((found) => found.id);
    expect(ids(false)).toEqual(["a"]);
    expect(ids(true)).toEqual(["a", "b"]);
  });

  it("filters by project, no project, and label", () => {
    const cards = [
      card("a", { projectId: "P1", labels: ["ui"] }),
      card("b", { projectId: "P2" }),
      card("c", { labels: ["ui"] }),
    ];
    const ids = (projectId: string, label: string) =>
      filterCards(cards, { projectId, label, showArchived: false }).map((found) => found.id);
    expect(ids("", "")).toEqual(["a", "b", "c"]);
    expect(ids("P1", "")).toEqual(["a"]);
    expect(ids("none", "")).toEqual(["c"]);
    expect(ids("", "ui")).toEqual(["a", "c"]);
    expect(labelsOf(cards)).toEqual(["ui"]);
  });

  it("finds drop and keyboard targets", () => {
    const columns = byColumn([
      card("c", { position: 2 }),
      card("a", { position: 0 }),
      card("b", { position: 1 }),
      card("r", { column: "ready" }),
    ]);
    expect(columns.backlog.map((found) => found.id)).toEqual(["a", "b", "c"]);
    expect(dropIndex(columns.backlog, "a", "c")).toBe(1);
    expect(dropIndex(columns.backlog, "c", "a")).toBe(0);
    expect(dropIndex(columns.backlog, "r", undefined)).toBe(3);

    const [a, b] = columns.backlog as [Card, Card];
    expect(stepTarget(a, "up", columns)).toBeUndefined();
    expect(stepTarget(a, "down", columns)).toEqual({ column: "backlog", index: 1 });
    expect(stepTarget(b, "up", columns)).toEqual({ column: "backlog", index: 0 });
    expect(stepTarget(a, "left", columns)).toBeUndefined();
    expect(stepTarget(a, "right", columns)).toEqual({ column: "ready" });
  });
});
