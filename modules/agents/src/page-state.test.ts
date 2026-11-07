import type { Agent } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { activity, emptyPage, reducePage } from "./page-state.js";

const agent: Agent = {
  id: "A",
  workspaceId: "W",
  role: "worker",
  kind: "worker",
  active: true,
  status: "idle",
  createdAt: 1,
};
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

  it("takes a changed title or active flag from an agent event", () => {
    let state = reducePage(emptyPage(), snapshot);
    state = reducePage(state, { type: "agent", agent: { ...agent, active: false, title: "Old" } });
    expect(state.agent).toMatchObject({ active: false, title: "Old" });
    expect(state.chat.messages).toHaveLength(1);
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

describe("activity", () => {
  const base = reducePage(emptyPage(), snapshot);
  const busy = reducePage(reducePage(base, { type: "status", status: "busy" }), {
    type: "pi",
    event: { type: "agent_start" },
  });
  const stream = (content: unknown[]) =>
    reducePage(busy, {
      type: "pi",
      event: { type: "message_start", message: { role: "assistant", content, timestamp: 9 } },
    });

  it("says nothing while idle", () => {
    expect(activity(base)).toBeUndefined();
  });

  it("names waiting and starting", () => {
    expect(activity(reducePage(base, { type: "status", status: "waiting" }))).toBe(
      "Waiting for a free agent slot",
    );
    expect(activity(reducePage(base, { type: "status", status: "starting" }))).toBe(
      "Starting the agent",
    );
  });

  it("says Thinking before any output and while thinking, then Writing", () => {
    expect(activity(busy)).toBe("Thinking");
    expect(activity(stream([{ type: "thinking", thinking: "hm" }]))).toBe("Thinking");
    expect(
      activity(
        stream([
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "Hi" },
        ]),
      ),
    ).toBe("Writing");
  });

  it("names the tool being prepared or run", () => {
    expect(activity(stream([{ type: "toolCall", name: "bash" }]))).toBe("Preparing bash");
    const running = reducePage(busy, {
      type: "pi",
      event: { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} },
    });
    expect(activity(running)).toBe("Running read");
  });
});
