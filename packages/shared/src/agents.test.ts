import { describe, expect, it } from "vitest";
import { type Agent, orderChats } from "./agents.js";

describe("orderChats", () => {
  it("lists the active worker chat, side chats, stage chats, then older worker chats, newest first", () => {
    const chat = (id: string, kind: Agent["kind"], active: boolean, createdAt: number) => ({
      id,
      kind,
      active,
      createdAt,
    });
    const ordered = orderChats([
      chat("older", "worker", false, 5),
      chat("stage-old", "stage", true, 2),
      chat("side", "side", true, 3),
      chat("stage-new", "stage", true, 4),
      chat("active", "worker", true, 1),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      "active",
      "side",
      "stage-new",
      "stage-old",
      "older",
    ]);
  });
});
