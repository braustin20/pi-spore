import Type, { type Static } from "typebox";

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

export const Agent = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  role: AgentRole,
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
