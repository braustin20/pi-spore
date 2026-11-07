import Type, { type Static } from "typebox";

/** Longest title the user may give a chat. */
const TITLE_MAX = 120;
/** Longest title taken from a first message. */
const AUTO_TITLE_MAX = 60;

/** A chat's title from its first user message: the first line with text, cut to a short label. */
export function chatTitle(message: string): string {
  const line =
    message
      .split("\n")
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find((part) => part !== "") ?? "";
  return line.length <= AUTO_TITLE_MAX ? line : `${line.slice(0, AUTO_TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * The order the chat page lists a workspace's chats in: the active worker chat, then side chats, then older worker
 * chats. Newest first within each group.
 */
export function orderChats<T extends Pick<Agent, "kind" | "active" | "createdAt">>(
  chats: readonly T[],
): T[] {
  const rank = (chat: T) => {
    if (chat.kind === "side") return 1;
    return chat.active ? 0 : 2;
  };
  return [...chats].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

/**
 * Where an agent process is. `waiting`: queued for a live slot (ADR 0026). `failed`: the last start or run failed;
 * the next prompt tries again.
 */
export const AgentStatus = Type.Union([
  Type.Literal("stopped"),
  Type.Literal("waiting"),
  Type.Literal("starting"),
  Type.Literal("idle"),
  Type.Literal("busy"),
  Type.Literal("failed"),
]);
export type AgentStatus = Static<typeof AgentStatus>;

export const AgentRole = Type.Literal("worker");
export type AgentRole = Static<typeof AgentRole>;

/**
 * A workspace's chats (ADR 0030). `worker`: the chat that writes; only the workspace's active worker chat can run.
 * `side`: a read-only chat next to it, with read-only tools only.
 */
export const ChatKind = Type.Union([Type.Literal("worker"), Type.Literal("side")]);
export type ChatKind = Static<typeof ChatKind>;

/** One Pi conversation of a workspace: a chat. */
export const Agent = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  role: AgentRole,
  kind: ChatKind,
  /**
   * Whether the chat can run: the workspace's active worker chat, or a side chat. An older worker chat is
   * read-only history until it is made active again.
   */
  active: Type.Boolean(),
  /** The first user message, cut short, or the name the user gave it. Missing until the first message. */
  title: Type.Optional(Type.String()),
  /** The worker chat whose context a side chat started from. */
  forkedFrom: Type.Optional(Type.String()),
  status: AgentStatus,
  /** Why the last start or run failed, with the tail of the process's stderr. */
  error: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
});
export type Agent = Static<typeof Agent>;

export const AgentModel = Type.Object({
  provider: Type.String(),
  id: Type.String(),
  name: Type.Optional(Type.String()),
  contextWindow: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Boolean()),
});
export type AgentModel = Static<typeof AgentModel>;

export const ContextUsage = Type.Object({
  tokens: Type.Union([Type.Number(), Type.Null()]),
  contextWindow: Type.Number(),
  percent: Type.Union([Type.Number(), Type.Null()]),
});
export type ContextUsage = Static<typeof ContextUsage>;

/** An extension dialog waiting for an answer (R5.6). Mirrors Pi's `extension_ui_request` for dialog methods. */
export const AgentDialog = Type.Object({
  id: Type.String(),
  method: Type.Union([
    Type.Literal("select"),
    Type.Literal("confirm"),
    Type.Literal("input"),
    Type.Literal("editor"),
  ]),
  title: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.String())),
  placeholder: Type.Optional(Type.String()),
  prefill: Type.Optional(Type.String()),
});
export type AgentDialog = Static<typeof AgentDialog>;

export const AgentList = Type.Object({ agents: Type.Array(Agent) });
export type AgentList = Static<typeof AgentList>;

export const CreateAgentRequest = Type.Object(
  { workspaceId: Type.String({ minLength: 1 }), role: Type.Optional(AgentRole) },
  { additionalProperties: false },
);
export type CreateAgentRequest = Static<typeof CreateAgentRequest>;

/** Starts a chat. A worker chat replaces the active one; `fork` starts a side chat from the worker's context. */
export const CreateChatRequest = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    kind: ChatKind,
    fork: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateChatRequest = Static<typeof CreateChatRequest>;

export const RenameChatRequest = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: TITLE_MAX }) },
  { additionalProperties: false },
);
export type RenameChatRequest = Static<typeof RenameChatRequest>;

export const PromptRequest = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 200_000 }),
    /** While the agent works: `steer` goes in after the current turn, `followUp` after the run. Default: steer. */
    whileBusy: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
  },
  { additionalProperties: false },
);
export type PromptRequest = Static<typeof PromptRequest>;

export const SetModelRequest = Type.Object(
  { provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type SetModelRequest = Static<typeof SetModelRequest>;

export const ThinkingLevel = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevel>;

export const SetThinkingRequest = Type.Object(
  { level: ThinkingLevel },
  { additionalProperties: false },
);
export type SetThinkingRequest = Static<typeof SetThinkingRequest>;

export const DialogAnswer = Type.Object(
  {
    dialogId: Type.String({ minLength: 1 }),
    value: Type.Optional(Type.String()),
    confirmed: Type.Optional(Type.Boolean()),
    cancelled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DialogAnswer = Static<typeof DialogAnswer>;

export const ModelList = Type.Object({
  models: Type.Array(AgentModel),
  thinkingLevels: Type.Array(ThinkingLevel),
});
export type ModelList = Static<typeof ModelList>;

export const SlashCommand = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String()),
  source: Type.String(),
});
export const CommandList = Type.Object({ commands: Type.Array(SlashCommand) });
export type CommandList = Static<typeof CommandList>;
