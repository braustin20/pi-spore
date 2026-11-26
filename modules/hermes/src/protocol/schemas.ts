import Type, { type Static, type TSchema } from "typebox";

// Shapes probed on Hermes v0.23.3 (docs/spikes/hermes-protocol.md). Hermes may add fields, so objects allow unknown
// keys; the fields pi-spore reads are required. Bodies pi-spore sends are closed: no extra key, and so no provider or
// model override (ADR 0202 decision 7).

const Open = <P extends Record<string, TSchema>>(properties: P) => Type.Object(properties);
const Closed = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });

/** `GET /p/<profile>/health`, no key needed. */
export const Health = Open({ status: Type.String(), version: Type.String() });

const Flag = Type.Optional(Type.Boolean());

/** `GET /v1/capabilities`. Flags are optional here, so a missing one is named instead of failing the parse. */
export const Capabilities = Open({
  features: Open({
    run_submission: Flag,
    run_status: Flag,
    run_events_sse: Flag,
    run_stop: Flag,
    run_approval_response: Flag,
    approval_events: Flag,
    session_resources: Flag,
    run_unknown_resolution: Flag,
    runs_idempotency: Type.Optional(Open({ supported: Flag, durable: Flag })),
  }),
});
export type Capabilities = Static<typeof Capabilities>;

/** `GET /v1/models`. */
export const Models = Open({ data: Type.Array(Open({ id: Type.String() })) });

export const RunStatusName = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting_for_approval"),
  Type.Literal("unknown"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
  Type.Literal("interrupted"),
]);

const Maybe = Type.Optional(Type.String());

/**
 * A control the run waits on. Its `prompt_id` is the `request_id` of the answer. The other fields are shown to the
 * user when present; the spike did not see their names on a live approval, so none is required (card Hermes 1.5).
 */
export const PendingControl = Open({
  prompt_id: Type.String(),
  kind: Maybe,
  command: Maybe,
  description: Maybe,
  question: Maybe,
});

// This build can leave the run's runtime fields blank. Blank means unknown, never a failure (ADR 0202 decision 7).
const Blank = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** `GET /v1/runs/{id}`. */
export const Run = Open({
  run_id: Type.String(),
  status: RunStatusName,
  admission_id: Type.Optional(Type.String()),
  execution_generation: Type.Optional(Type.Integer()),
  session_id: Type.Optional(Type.String()),
  output: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pending_controls: Type.Optional(Type.Array(PendingControl)),
  runtime: Type.Optional(Open({ provider: Blank, model: Blank })),
});
export type Run = Static<typeof Run>;

/** The `202` of `POST /v1/runs`. Its `status` says `started` even for a queued run; read the run for the truth. */
export const RunAdmission = Open({
  run_id: Type.String(),
  status: Type.String(),
  replayed: Type.Optional(Type.Boolean()),
});
export type RunAdmission = Static<typeof RunAdmission>;

/** `POST /v1/runs/{id}/stop` and `.../resolve-unknown`. */
export const RunControlAnswer = Open({ run_id: Type.String(), status: Type.String() });
export type RunControlAnswer = Static<typeof RunControlAnswer>;

/** A Hermes session. Ownership is `source` only: pi-spore writes only into `api_server` sessions. */
export const Session = Open({
  id: Type.String(),
  source: Type.String(),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  model: Blank,
  billing_provider: Blank,
});
export type Session = Static<typeof Session>;

/** `POST /api/sessions`. */
export const SessionCreated = Open({ session: Session });

/** `GET /api/sessions`. */
export const SessionList = Open({
  data: Type.Array(Session),
  has_more: Type.Optional(Type.Boolean()),
});
export type SessionList = Static<typeof SessionList>;

export const SessionMessage = Open({
  id: Type.Integer(),
  role: Type.String(),
  content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  tool_name: Blank,
});

/** `GET /api/sessions/{id}/messages`. */
export const SessionMessages = Open({ data: Type.Array(SessionMessage) });
export type SessionMessages = Static<typeof SessionMessages>;

/** An error body: `{"error": {"code", "message"}}`. */
export const ErrorBody = Open({
  error: Open({ code: Type.Optional(Type.String()), message: Type.Optional(Type.String()) }),
});

// Bodies pi-spore sends.

/** `POST /v1/runs`. No provider or model: Hermes's own routing decides. */
export const StartRunBody = Closed({
  input: Type.String({ minLength: 1 }),
  session_id: Type.String({ minLength: 1 }),
});
export type StartRunBody = Static<typeof StartRunBody>;

const Generation = Type.Integer({ minimum: 0 });

/** `POST /v1/runs/{id}/approval`. pi-spore never sends `session` or `always`. */
export const ApprovalAnswer = Closed({
  request_id: Type.String({ minLength: 1 }),
  execution_generation: Generation,
  choice: Type.Union([Type.Literal("once"), Type.Literal("deny")]),
});
export type ApprovalAnswer = Static<typeof ApprovalAnswer>;

/** `POST /v1/runs/{id}/clarify`. */
export const ClarifyAnswer = Closed({
  request_id: Type.String({ minLength: 1 }),
  execution_generation: Generation,
  answer: Type.String(),
});
export type ClarifyAnswer = Static<typeof ClarifyAnswer>;

/** `POST /v1/runs/{id}/resolve-unknown`: the exact pair from the run status. */
export const ResolveUnknownBody = Closed({
  admission_id: Type.String({ minLength: 1 }),
  execution_generation: Generation,
});
export type ResolveUnknownBody = Static<typeof ResolveUnknownBody>;

/** `POST /api/sessions`. */
export const CreateSessionBody = Closed({
  id: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String()),
});
export type CreateSessionBody = Static<typeof CreateSessionBody>;
