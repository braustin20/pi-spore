import Type, { type Static } from "typebox";

/**
 * What the Hermes connector knows now (ADR 0202). `disabled` means `hermes.enabled` is off and nothing was sent.
 * `detail` names the URL, the key file path, the versions, or the flags; it never holds the key.
 */
export const HermesStatus = Type.Union([
  Type.Object({ state: Type.Literal("disabled") }),
  Type.Object({
    state: Type.Union([
      Type.Literal("unreachable"),
      Type.Literal("unauthorized"),
      Type.Literal("incompatible"),
    ]),
    detail: Type.String(),
    checkedAt: Type.Integer(),
  }),
  Type.Object({
    state: Type.Literal("ready"),
    version: Type.String(),
    url: Type.String(),
    profile: Type.String(),
    checkedAt: Type.Integer(),
  }),
]);
export type HermesStatus = Static<typeof HermesStatus>;

/** The life of a handoff to Hermes (ADR 0202, card Hermes 1.2). The last four end it. */
export const HermesHandoffState = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
  Type.Literal("uncertain"),
]);
export type HermesHandoffState = Static<typeof HermesHandoffState>;

export const HermesAskKind = Type.Union([Type.Literal("question"), Type.Literal("task")]);

/** `POST /api/bridge/hermes/asks`, the body of the `ask_hermes` tool. */
export const AskHermesRequest = Type.Object(
  {
    kind: HermesAskKind,
    text: Type.String({ minLength: 1, maxLength: 8_000 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type AskHermesRequest = Static<typeof AskHermesRequest>;

/** An approval or a clarify question that a Hermes run waits on. Only the user answers it, on the Hermes page. */
export const HermesControl = Type.Object({
  promptId: Type.String(),
  kind: Type.Union([Type.Literal("approval"), Type.Literal("clarify")]),
  command: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  question: Type.Optional(Type.String()),
  /** `answering` while the one post of an answer is on its way. */
  state: Type.Union([
    Type.Literal("open"),
    Type.Literal("answering"),
    Type.Literal("answered"),
    Type.Literal("expired"),
  ]),
  createdAt: Type.Integer(),
  /** When Hermes stops waiting (`approvals.timeout`). */
  expiresAt: Type.Integer(),
});
export type HermesControl = Static<typeof HermesControl>;

/** What the user picked for an `uncertain` handoff. */
export const HermesResolution = Type.Union([
  Type.Literal("interrupted"),
  Type.Literal("resent"),
  Type.Literal("dropped"),
]);

/** One handoff from a Pi chat to Hermes. `provider` and `model` come from the Hermes session record; absent is unknown. */
export const HermesHandoff = Type.Object({
  id: Type.String(),
  direction: Type.Literal("out"),
  agentId: Type.String(),
  workspaceId: Type.String(),
  projectId: Type.String(),
  profile: Type.String(),
  kind: HermesAskKind,
  title: Type.Optional(Type.String()),
  text: Type.String(),
  state: HermesHandoffState,
  runId: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  result: Type.Optional(Type.String()),
  /** Why it failed, or, while `pending`, why it waits (such as "Hermes is offline: ..."). */
  error: Type.Optional(Type.String()),
  resolution: Type.Optional(HermesResolution),
  /** The new handoff of a "Send again". */
  resentAs: Type.Optional(Type.String()),
  controls: Type.Array(HermesControl),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type HermesHandoff = Static<typeof HermesHandoff>;

/** What is known about an `uncertain` handoff before the user picks (ADR 0202 decision 6). */
export const HermesReconcile = Type.Object({
  handoff: HermesHandoff,
  /** The run's status now, or why it could not be read. */
  runStatus: Type.String(),
  toolStarted: Type.Optional(Type.String()),
  toolFinished: Type.Optional(Type.String()),
  /** The newest messages of the handoff's session, oldest first, each cut short. */
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.Optional(Type.String()),
      tool: Type.Optional(Type.String()),
    }),
  ),
});
export type HermesReconcile = Static<typeof HermesReconcile>;

/** The user's answer to a control: `choice` for an approval, never `session` or `always`; `answer` for a clarify. */
export const AnswerHermesControlRequest = Type.Union([
  Type.Object(
    { choice: Type.Union([Type.Literal("once"), Type.Literal("deny")]) },
    { additionalProperties: false },
  ),
  Type.Object(
    { answer: Type.String({ minLength: 1, maxLength: 8_000 }) },
    { additionalProperties: false },
  ),
]);
export type AnswerHermesControlRequest = Static<typeof AnswerHermesControlRequest>;

/** The user's pick for an `uncertain` handoff. "Send again" needs the confirm that the first may have run. */
export const ResolveHermesHandoffRequest = Type.Union([
  Type.Object(
    { action: Type.Union([Type.Literal("interrupt"), Type.Literal("drop")]) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("resend"), confirmed: Type.Literal(true) },
    { additionalProperties: false },
  ),
]);
export type ResolveHermesHandoffRequest = Static<typeof ResolveHermesHandoffRequest>;
