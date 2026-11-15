import { describe, expect, it } from "vitest";
import { applyPiEvent, type ChatState, chatActivity, emptyChat, toolActivity } from "./chat.js";

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

describe("toolActivity (R15)", () => {
  it("names the tool with the one argument a row shows", () => {
    expect(toolActivity("Running", "bash", { command: "npm test" })).toBe("Running bash: npm test");
    expect(toolActivity("Running", "read", { path: "docs/vision.md" })).toBe(
      "Running read: docs/vision.md",
    );
    expect(toolActivity("Ran", "edit", { path: "a.ts" })).toBe("Ran edit: a.ts");
    expect(toolActivity("Ran", "write", { path: "b.ts" })).toBe("Ran write: b.ts");
  });

  it("leaves the argument out for a tool it does not name, or one that is not text", () => {
    expect(toolActivity("Running", "grep", { pattern: "TODO" })).toBe("Running grep");
    expect(toolActivity("Running", "bash", { path: "not-a-command" })).toBe("Running bash");
    expect(toolActivity("Running", "read", { command: "not-a-path" })).toBe("Running read");
    expect(toolActivity("Running", "bash", { command: 7 })).toBe("Running bash");
    expect(toolActivity("Running", "bash", { command: "   \ngit status" })).toBe("Running bash");
    expect(toolActivity("Running", "bash", undefined)).toBe("Running bash");
    expect(toolActivity("Running", "bash", "npm test")).toBe("Running bash");
  });

  it("keeps one line, trimmed", () => {
    expect(toolActivity("Running", "bash", { command: "echo one\ngit status" })).toBe(
      "Running bash: echo one",
    );
    expect(toolActivity("Running", "bash", { command: "  ls -la  \ngit status" })).toBe(
      "Running bash: ls -la",
    );
  });

  it("cuts the argument at any line break, not only a line feed", () => {
    expect(toolActivity("Running", "bash", { command: "echo one\r\ngit status" })).toBe(
      "Running bash: echo one",
    );
    expect(toolActivity("Running", "bash", { command: "echo one\rgit status" })).toBe(
      "Running bash: echo one",
    );
    expect(toolActivity("Running", "read", { path: "a\u2028b" })).toBe("Running read: a");
    expect(toolActivity("Ran", "write", { path: "a\u2029b" })).toBe("Ran write: a");
  });

  it("cuts a long line to 80 characters", () => {
    const text = toolActivity("Running", "read", { path: "x".repeat(200) });
    expect(text.length).toBe(80);
    expect(text.endsWith("…")).toBe(true);
    expect(text).toBe(`Running read: ${"x".repeat(80 - "Running read: ".length - 1)}…`);
    expect(toolActivity("Running", "bash", { command: "y".repeat(66) })).toBe(
      `Running bash: ${"y".repeat(66)}`,
    );
  });
});

describe("chatActivity (R15)", () => {
  const replied = (content: unknown, timestamp = 5) => ({
    role: "assistant",
    content,
    timestamp,
  });
  const call = (name: string, args: Record<string, unknown>, id = "c1") => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });

  it("names the newest running tool, ahead of the messages", () => {
    const state: ChatState = {
      ...emptyChat(),
      messages: [replied([{ type: "text", text: "Done" }])],
      running: [
        { toolCallId: "c1", toolName: "read", args: { path: "a.ts" } },
        { toolCallId: "c2", toolName: "bash", args: { command: "npm test" } },
      ],
    };
    expect(chatActivity(state)).toBe("Running bash: npm test");
  });

  it("names the last tool call of the newest assistant message", () => {
    const state: ChatState = {
      ...emptyChat(),
      messages: [
        replied([{ type: "text", text: "Looking" }]),
        replied([
          { type: "thinking", thinking: "hm" },
          call("read", { path: "a.ts" }, "c1"),
          call("bash", { command: "npm test" }, "c2"),
        ]),
      ],
    };
    expect(chatActivity(state)).toBe("Ran bash: npm test");
  });

  it("says what it replied with, from the first line of text", () => {
    const state: ChatState = {
      ...emptyChat(),
      messages: [
        replied([{ type: "text", text: "First answer" }]),
        replied([
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "\n  All set.\nNothing else." },
        ]),
      ],
    };
    expect(chatActivity(state)).toBe("Replied: All set.");
    const long: ChatState = {
      ...emptyChat(),
      messages: [replied([{ type: "text", text: `${"z".repeat(200)} tail` }])],
    };
    expect(chatActivity(long)).toBe(`Replied: ${"z".repeat(80 - "Replied: ".length - 1)}…`);
  });

  it("takes the first line of the reply at any line break", () => {
    const state: ChatState = {
      ...emptyChat(),
      messages: [replied([{ type: "text", text: "First\u2028Second\rThird" }])],
    };
    expect(chatActivity(state)).toBe("Replied: First");
  });

  it("skips a message with only thinking, and an empty one", () => {
    const state: ChatState = {
      ...emptyChat(),
      messages: [
        replied([{ type: "text", text: "Earlier answer" }], 3),
        replied([{ type: "thinking", thinking: "hm" }], 4),
        replied([], 5),
      ],
    };
    expect(chatActivity(state)).toBe("Replied: Earlier answer");
  });

  it("says nothing without a finished assistant step, and never reads a tool result", () => {
    expect(chatActivity(emptyChat())).toBeUndefined();
    expect(
      chatActivity({
        ...emptyChat(),
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ls out" }] },
        ],
        streaming: replied([{ type: "text", text: "Still writing" }], 9),
      }),
    ).toBeUndefined();
  });
});
