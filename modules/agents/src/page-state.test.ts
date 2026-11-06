import type { Agent } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { emptyPage, reducePage } from "./page-state.js";

const agent: Agent = { id: "A", workspaceId: "W", role: "worker", status: "idle", createdAt: 1 };
const snapshot = {
  type: "snapshot",
  agent,
  model: { provider: "p", id: "m" },
  thinkingLevel: "high",
  dialogs: [],
  chat: {
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
    running: [],
    queue: { steering: [], followUp: [] },
    busy: false,
  },
};

describe("reducePage", () => {
  it("takes a snapshot whole, then applies Pi events to the chat", () => {
    let state = reducePage(emptyPage(), snapshot);
    state = reducePage(state, { type: "pi", event: { type: "agent_start" } });
    expect(state.agent).toEqual(agent);
    expect(state.model).toEqual({ provider: "p", id: "m" });
    expect(state.chat.messages).toHaveLength(1);
    expect(state.chat.busy).toBe(true);
  });

  it("sets and clears the error with the status", () => {
    let state = reducePage(emptyPage(), snapshot);
    state = reducePage(state, { type: "status", status: "failed", error: "boom" });
    expect(state.agent).toMatchObject({ status: "failed", error: "boom" });
    state = reducePage(state, { type: "status", status: "idle" });
    expect(state.agent?.status).toBe("idle");
    expect(state.agent?.error).toBeUndefined();
  });

  it("opens and closes dialogs, keeps the latest notices, and updates model and stats", () => {
    let state = reducePage(emptyPage(), snapshot);
    state = reducePage(state, {
      type: "dialog",
      dialog: { id: "d1", method: "confirm", title: "Go?" },
    });
    expect(state.dialogs.map((dialog) => dialog.id)).toEqual(["d1"]);
    state = reducePage(state, { type: "dialog_closed", dialogId: "d1" });
    expect(state.dialogs).toEqual([]);

    for (let i = 0; i < 7; i++)
      state = reducePage(state, { type: "notice", level: "info", message: `n${i}` });
    expect(state.notices.map((notice) => notice.message)).toEqual(["n2", "n3", "n4", "n5", "n6"]);

    state = reducePage(state, {
      type: "model",
      model: { provider: "p", id: "m2" },
      thinkingLevel: "low",
    });
    expect(state).toMatchObject({ model: { id: "m2" }, thinkingLevel: "low" });
    state = reducePage(state, {
      type: "stats",
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
    });
    expect(state.contextUsage?.percent).toBe(10);
  });

  it("ignores status changes before the snapshot, and garbage", () => {
    expect(reducePage(emptyPage(), { type: "status", status: "busy" }).agent).toBeUndefined();
    expect(reducePage(emptyPage(), 42)).toEqual(emptyPage());
  });
});
