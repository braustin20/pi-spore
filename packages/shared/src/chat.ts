/**
 * Chat state rebuilt from Pi's RPC events (Pi docs: json.md). The server keeps one per agent for snapshots; the web
 * app keeps one per open chat. Both use `applyPiEvent`, so they agree.
 *
 * Messages are Pi `AgentMessage` values, kept loosely typed: Pi may add roles and fields, and the chat only reads a
 * few of them.
 */

export interface ChatMessage {
  role: string;
  timestamp?: number;
  content?: unknown;
  [field: string]: unknown;
}

export interface RunningTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** The latest partial result a tool reported. */
  partial?: unknown;
}

export interface ChatState {
  messages: ChatMessage[];
  /** The assistant message being streamed, if any. */
  streaming?: ChatMessage;
  running: RunningTool[];
  queue: { steering: string[]; followUp: string[] };
  /** True between `agent_start` and `agent_settled`. */
  busy: boolean;
}

export const emptyChat = (): ChatState => ({
  messages: [],
  running: [],
  queue: { steering: [], followUp: [] },
  busy: false,
});

type Block = Record<string, unknown>;
type Event = Record<string, unknown> & { type?: unknown };

/** The same message seen twice (in a snapshot and again in a live event) has the same role and timestamp. */
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role && a.timestamp !== undefined && a.timestamp === b.timestamp;
}

function withMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((existing) => sameMessage(existing, message));
  if (index === -1) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

/** Applies one `assistantMessageEvent` (text, thinking, and tool-call block deltas) to the streaming message. */
function applyDelta(message: ChatMessage, delta: Event): ChatMessage {
  const content: Block[] = Array.isArray(message.content) ? [...(message.content as Block[])] : [];
  const index = typeof delta.contentIndex === "number" ? delta.contentIndex : -1;
  const block = index >= 0 ? { ...(content[index] ?? {}) } : undefined;
  switch (delta.type) {
    case "text_start":
      if (block) content[index] = { type: "text", text: "" };
      break;
    case "thinking_start":
      if (block) content[index] = { type: "thinking", thinking: "" };
      break;
    case "toolcall_start":
      if (block)
        content[index] = {
          type: "toolCall",
          id: delta.id,
          name: delta.toolName,
          arguments: {},
          argsText: "",
        };
      break;
    case "text_delta":
      if (block)
        content[index] = {
          ...block,
          type: "text",
          text: `${block.text ?? ""}${String(delta.delta ?? "")}`,
        };
      break;
    case "thinking_delta":
      if (block) {
        content[index] = {
          ...block,
          type: "thinking",
          thinking: `${block.thinking ?? ""}${String(delta.delta ?? "")}`,
        };
      }
      break;
    case "toolcall_delta":
      if (block)
        content[index] = {
          ...block,
          argsText: `${block.argsText ?? ""}${String(delta.delta ?? "")}`,
        };
      break;
    case "text_end":
      if (block) content[index] = { type: "text", text: delta.content };
      break;
    case "thinking_end":
      if (block) content[index] = { type: "thinking", thinking: delta.content };
      break;
    case "toolcall_end":
      if (block && typeof delta.toolCall === "object" && delta.toolCall !== null) {
        content[index] = { type: "toolCall", ...(delta.toolCall as Block) };
      }
      break;
    default:
      return message;
  }
  return { ...message, content };
}

/** Applies one Pi RPC event. Unknown events leave the state as it is. */
export function applyPiEvent(state: ChatState, raw: unknown): ChatState {
  if (typeof raw !== "object" || raw === null) return state;
  const event = raw as Event;
  switch (event.type) {
    case "agent_start":
      return { ...state, busy: true };
    case "agent_settled":
      return { ...state, busy: false, running: [] };
    case "message_start": {
      const message = event.message as ChatMessage | undefined;
      if (!message) return state;
      return message.role === "assistant" ? { ...state, streaming: message } : state;
    }
    case "message_update": {
      if (!state.streaming || typeof event.assistantMessageEvent !== "object") return state;
      return {
        ...state,
        streaming: applyDelta(state.streaming, event.assistantMessageEvent as Event),
      };
    }
    case "message_end": {
      const message = event.message as ChatMessage | undefined;
      if (!message) return state;
      const messages = withMessage(state.messages, message);
      if (message.role !== "assistant") return { ...state, messages };
      const { streaming: _done, ...rest } = state;
      return { ...rest, messages };
    }
    case "tool_execution_start":
      return {
        ...state,
        running: [
          ...state.running.filter((tool) => tool.toolCallId !== event.toolCallId),
          {
            toolCallId: String(event.toolCallId),
            toolName: String(event.toolName),
            args: event.args,
          },
        ],
      };
    case "tool_execution_update":
      return {
        ...state,
        running: state.running.map((tool) =>
          tool.toolCallId === event.toolCallId ? { ...tool, partial: event.partialResult } : tool,
        ),
      };
    case "tool_execution_end":
      return {
        ...state,
        running: state.running.filter((tool) => tool.toolCallId !== event.toolCallId),
      };
    case "queue_update":
      return {
        ...state,
        queue: {
          steering: Array.isArray(event.steering) ? (event.steering as string[]) : [],
          followUp: Array.isArray(event.followUp) ? (event.followUp as string[]) : [],
        },
      };
    default:
      return state;
  }
}
