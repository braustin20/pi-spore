import { describe, expect, it } from "vitest";
import { applyPiEvent, type ChatState, emptyChat } from "./chat.js";

const replay = (events: unknown[], start: ChatState = emptyChat()) =>
  events.reduce(applyPiEvent, start);

const user = { role: "user", content: "hi", timestamp: 1 };
const assistantStart = { role: "assistant", content: [], stopReason: "pending", timestamp: 2 };

describe("applyPiEvent", () => {
  it("streams text and thinking deltas into the assistant message, then replaces it with the final one", () => {
    const final = {
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      stopReason: "stop",
      timestamp: 2,
    };
    const states: ChatState[] = [];
    let state = emptyChat();
    for (const event of [
      { type: "agent_start" },
      { type: "message_start", message: user },
      { type: "message_end", message: user },
      { type: "message_start", message: assistantStart },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" },
      },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" },
      },
      { type: "message_end", message: final },
      { type: "agent_settled", aborted: false },
    ]) {
      state = applyPiEvent(state, event);
      states.push(state);
    }

    expect(states[8]?.streaming?.content).toEqual([
      { type: "thinking", thinking: "hm" },
      { type: "text", text: "Hello" },
    ]);
    expect(states[8]?.busy).toBe(true);
    expect(state.messages).toEqual([user, final]);
    expect(state.streaming).toBeUndefined();
    expect(state.busy).toBe(false);
  });

  it("builds a streamed tool call and tracks the running tool until it ends", () => {
    const state = replay([
      { type: "message_start", message: assistantStart },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          id: "c1",
          toolName: "bash",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":' },
      },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: "a\n" },
    ]);
    expect(state.streaming?.content).toEqual([
      { type: "toolCall", id: "c1", name: "bash", arguments: {}, argsText: '{"command":' },
    ]);
    expect(state.running).toEqual([
      { toolCallId: "c1", toolName: "bash", args: { command: "ls" }, partial: "a\n" },
    ]);
    expect(applyPiEvent(state, { type: "tool_execution_end", toolCallId: "c1" }).running).toEqual(
      [],
    );
  });

  it("does not duplicate a message that a snapshot already had", () => {
    const start: ChatState = { ...emptyChat(), messages: [user] };
    expect(applyPiEvent(start, { type: "message_end", message: user }).messages).toEqual([user]);
  });

  it("keeps the latest queue and ignores unknown events and garbage", () => {
    let state = applyPiEvent(emptyChat(), {
      type: "queue_update",
      steering: ["stop"],
      followUp: [],
    });
    state = applyPiEvent(state, { type: "something_new" });
    state = applyPiEvent(state, null);
    state = applyPiEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" },
    });
    expect(state.queue).toEqual({ steering: ["stop"], followUp: [] });
    expect(state.messages).toEqual([]);
  });
});
