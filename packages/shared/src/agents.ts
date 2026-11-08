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
 * The order the chat page lists a workspace's chats in: the active worker chat, then side chats, then stage chats,
 * then older worker chats. Newest first within each group.
 */
export function orderChats<T extends Pick<Agent, "kind" | "active" | "createdAt">>(
  chats: readonly T[],
): T[] {
  const rank = (chat: T) => {
    if (chat.kind === "side") return 1;
    if (chat.kind === "stage") return 2;
    return chat.active ? 0 : 3;
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

/** The roles of a review pipeline's stage agents (R6, ADR 0006). */
export const StageRole = Type.Union([
  Type.Literal("worker"),
  Type.Literal("reviewer"),
  Type.Literal("adversarial-reviewer"),
]);
export type StageRole = Static<typeof StageRole>;

/** `orchestrator`: a workspace chat. The others are the stage roles of a pipeline's agents. */
export const AgentRole = Type.Union([Type.Literal("orchestrator"), StageRole]);
export type AgentRole = Static<typeof AgentRole>;

/**
 * A workspace's chats (ADR 0030). `worker`: the chat that writes; only the workspace's active worker chat can run.
 * `side`: a read-only chat next to it, with read-only tools only. `stage`: an agent of a review pipeline stage (R6);
 * its role says what it may do.
 */
export const ChatKind = Type.Union([
  Type.Literal("worker"),
  Type.Literal("side"),
  Type.Literal("stage"),
]);
export type ChatKind = Static<typeof ChatKind>;

/** A model as `provider/id`: a provider without a slash or space, then an id without a space (ADR 0120). */
export const ModelRef = Type.String({ pattern: "^[^\\s/]+/\\S+$" });
export type ModelRef = Static<typeof ModelRef>;

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
  /** How many background helper runs are running. Missing when none. */
  helpersRunning: Type.Optional(Type.Integer()),
  /** "Waiting for <model>" while the router waits for a busy local model (R4.5). Missing otherwise. */
  routerStatus: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
});
export type Agent = Static<typeof Agent>;

export const AgentModel = Type.Object({
  provider: Type.String(),
  id: Type.String(),
  name: Type.Optional(Type.String()),
  contextWindow: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Boolean()),
  /** What the model takes, such as `["text", "image"]`. Pi sends a placeholder for an image to a text-only model. */
  input: Type.Optional(Type.Array(Type.String())),
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

/** Where a pi-subagents helper is. `paused` and `partial` are runs that stopped short and wait for the worker. */
export const ChildRunState = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("complete"),
  Type.Literal("failed"),
  Type.Literal("partial"),
  Type.Literal("paused"),
  Type.Literal("stopped"),
  Type.Literal("rejected"),
]);
export type ChildRunState = Static<typeof ChildRunState>;

/** One step of a child run: one agent. A single helper has one step; a chain or workflow has several. */
export const ChildRunStep = Type.Object({
  id: Type.String(),
  label: Type.String(),
  state: ChildRunState,
  agent: Type.Optional(Type.String()),
  /** `provider/model` as pi-subagents reports it. */
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  currentTool: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.Integer()),
  endedAt: Type.Optional(Type.Integer()),
});
export type ChildRunStep = Static<typeof ChildRunStep>;

/**
 * A background pi-subagents helper of a worker chat (R3.3, ADR 0034): one runner process. Foreground helpers run
 * inside the worker's process and are not child runs.
 */
export const ChildRun = Type.Object({
  id: Type.String(),
  label: Type.String(),
  state: ChildRunState,
  currentTool: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.Integer()),
  endedAt: Type.Optional(Type.Integer()),
  steps: Type.Array(ChildRunStep),
});
export type ChildRun = Static<typeof ChildRun>;

/** What a child run's agent said and did, from `/subagents-inspect-rpc`. Fields are missing when pi-subagents has none. */
export const ChildTranscript = Type.Object({
  childId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      kind: Type.String(),
      text: Type.String(),
      name: Type.Optional(Type.String()),
      isError: Type.Optional(Type.Boolean()),
    }),
  ),
  finalOutput: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  truncated: Type.Boolean(),
});
export type ChildTranscript = Static<typeof ChildTranscript>;

export const AgentList = Type.Object({ agents: Type.Array(Agent) });
export type AgentList = Static<typeof AgentList>;

export const CreateAgentRequest = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    role: Type.Optional(Type.Literal("orchestrator")),
    /** The model of the new chat. An existing active chat keeps its own. */
    model: Type.Optional(ModelRef),
  },
  { additionalProperties: false },
);
export type CreateAgentRequest = Static<typeof CreateAgentRequest>;

/** Starts a chat. A worker chat replaces the active one; `fork` starts a side chat from the worker's context. */
export const CreateChatRequest = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    kind: ChatKind,
    fork: Type.Optional(Type.Boolean()),
    /** The model of a new worker chat. A side chat ignores it. */
    model: Type.Optional(ModelRef),
  },
  { additionalProperties: false },
);
export type CreateChatRequest = Static<typeof CreateChatRequest>;

export const RenameChatRequest = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: TITLE_MAX }) },
  { additionalProperties: false },
);
export type RenameChatRequest = Static<typeof RenameChatRequest>;

/** Image types the chat sends to Pi and shows (R5.1). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * An image sent with a message, as base64 without a `data:` prefix. The schema caps the text; the server checks the
 * decoded size against its limit and the bytes against the type.
 */
export const PromptImage = Type.Object(
  {
    mimeType: Type.Union(IMAGE_TYPES.map((type) => Type.Literal(type))),
    data: Type.String({
      minLength: 1,
      maxLength: 64 * 1024 * 1024,
      pattern: "^[A-Za-z0-9+/]*={0,2}$",
    }),
  },
  { additionalProperties: false },
);
export type PromptImage = Static<typeof PromptImage>;

export const PromptRequest = Type.Object(
  {
    /** May be empty when the message has images. */
    message: Type.String({ maxLength: 200_000 }),
    images: Type.Optional(Type.Array(PromptImage, { maxItems: 32 })),
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

/** Pi's `get_available_models` data, and the answer of `GET /api/agents/models` (ADR 0120). */
export const ModelChoices = Type.Object({ models: Type.Array(AgentModel) });
export type ModelChoices = Static<typeof ModelChoices>;

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
