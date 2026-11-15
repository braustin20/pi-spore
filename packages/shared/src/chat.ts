/**
 * Chat state rebuilt from Pi's RPC events (Pi docs: json.md). The server keeps one per agent for snapshots; the web
 * app keeps one per open chat. Both use `applyPiEvent`, so they agree.
 *
 * Messages are Pi `AgentMessage` values, kept loosely typed: Pi may add roles and fields, and the chat only reads a
 * few of them.
 */

/**
 * An image block as the server sends it to pages (ADR 0060). Pi's base64 `data` is replaced by `ref`, the SHA-256 of
 * that data, which the page fetches from `GET /api/agents/:id/images/:ref`. Snapshots and live events stay small.
 */
export interface ImageRef {
  type: "image";
  mimeType: string;
  ref: string;
  /** Decoded size in bytes. */
  bytes: number;
}

export function isImageRef(block: unknown): block is ImageRef {
  if (typeof block !== "object" || block === null) return false;
  const image = block as Record<string, unknown>;
  return (
    image.type === "image" && typeof image.ref === "string" && typeof image.mimeType === "string"
  );
}

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

/** What one agent did last shows in one short row on Home and in the chat page (R15). */
const ACTIVITY_LIMIT = 80;

/** Where one text value becomes more than one line: CRLF, a lone CR, and the Unicode line separators, not only LF. */
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;

/** Cut an activity line to at most 80 characters, the last one an ellipsis. */
function activityLine(text: string): string {
  return text.length <= ACTIVITY_LIMIT ? text : `${text.slice(0, ACTIVITY_LIMIT - 1)}…`;
}

/** The one argument of a tool call worth showing: its command, or its path. Never its result. */
function toolArgument(toolName: string, args: unknown): string | undefined {
  const key =
    toolName === "bash"
      ? "command"
      : toolName === "read" || toolName === "edit" || toolName === "write"
        ? "path"
        : undefined;
  if (key === undefined || typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const line = (value.split(LINE_BREAK)[0] ?? "").trim();
  return line === "" ? undefined : line;
}

/**
 * What an agent does with one tool, as one line: `"<verb> <tool>: <arg>"`, with the argument left out for a tool
 * whose argument the row would not show (R15). The verb says whether it runs now or ran last (`Running`, `Ran`).
 */
export function toolActivity(verb: string, toolName: string, args: unknown): string {
  const argument = toolArgument(toolName, args);
  return activityLine(
    argument === undefined ? `${verb} ${toolName}` : `${verb} ${toolName}: ${argument}`,
  );
}

/**
 * What the agent did last, as one short line, or undefined when the chat has shown nothing yet (R15). A tool that
 * runs now comes first, then the last step of the newest finished message: the tool it called, or what it said.
 * It reads only finished messages and running tools, never streamed text and never a tool's result.
 */
export function chatActivity(chat: ChatState): string | undefined {
  const running = chat.running.at(-1);
  if (running) return toolActivity("Running", running.toolName, running.args);
  for (const message of chat.messages.toReversed()) {
    if (message.role !== "assistant") continue;
    const content: Block[] = Array.isArray(message.content) ? (message.content as Block[]) : [];
    const call = content.findLast((block) => block.type === "toolCall");
    if (call) return toolActivity("Ran", String(call.name ?? "a tool"), call.arguments);
    // A message with only thinking or no content at all is not something the agent did visibly.
    const said = content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n")
      .split(LINE_BREAK)
      .find((line) => line.trim() !== "");
    if (said !== undefined) return activityLine(`Replied: ${said.trim()}`);
  }
  return undefined;
}

/**
 * The physical model the router picked for a virtual model such as `spore/auto`, or undefined before any answer.
 * Pi records the physical model on each assistant message, so this follows reloads and reconnects (ADR 0009).
 */
export function routedModel(chat: ChatState): { provider: string; id: string } | undefined {
  const messages = chat.streaming ? [...chat.messages, chat.streaming] : chat.messages;
  for (const message of messages.toReversed()) {
    if (
      message.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      return { provider: message.provider, id: message.model };
    }
  }
  return undefined;
}

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
