import Type, { type Static } from "typebox";
import { ActionRun } from "./actions.js";
import { AgentDialog, AgentStatus, ChatKind } from "./agents.js";
import { Job } from "./jobs.js";
import { WorkspaceState } from "./workspaces.js";

/**
 * A question an agent filed for the user with `request_human_input` (R3.5, ADR 0008). `closed`: its chat stopped
 * being the active worker chat before an answer came (ADR 0033).
 */
export const Question = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  workspaceId: Type.String(),
  question: Type.String(),
  choices: Type.Optional(Type.Array(Type.String())),
  state: Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("closed")]),
  answer: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
  answeredAt: Type.Optional(Type.Integer()),
});
export type Question = Static<typeof Question>;

/** What spore-bridge's `request_human_input` sends. */
export const FileQuestionRequest = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 4_000 }),
    choices: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 8 }),
    ),
  },
  { additionalProperties: false },
);
export type FileQuestionRequest = Static<typeof FileQuestionRequest>;

export const AnswerQuestionRequest = Type.Object(
  { answer: Type.String({ minLength: 1, maxLength: 20_000 }) },
  { additionalProperties: false },
);
export type AnswerQuestionRequest = Static<typeof AnswerQuestionRequest>;

/**
 * A decision gate on Home (ADR 0100). The module that owns its `kind` checks the subject and carries out an approval;
 * the asking agent gets the outcome as a message.
 */
export const ApprovalState = Type.Union([
  Type.Literal("open"),
  Type.Literal("approved"),
  Type.Literal("declined"),
]);
export type ApprovalState = Static<typeof ApprovalState>;

export const Approval = Type.Object({
  id: Type.String(),
  /** Which gate, such as `card-start`. */
  kind: Type.String(),
  /** The agent (chat) that asked. */
  agentId: Type.String(),
  workspaceId: Type.String(),
  /** One line that says what would happen. */
  title: Type.String(),
  /** Why the agent asks. */
  reason: Type.String(),
  /** What to approve, in the kind's own shape. */
  subject: Type.Unknown(),
  state: ApprovalState,
  /** What happened, or the user's note on a decline. */
  outcome: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
  decidedAt: Type.Optional(Type.Integer()),
});
export type Approval = Static<typeof Approval>;

export const ApprovalList = Type.Object({ approvals: Type.Array(Approval) });
export type ApprovalList = Static<typeof ApprovalList>;

/** `subject`: a changed subject, such as another target; the kind's schema checks it. */
export const ApproveRequest = Type.Object(
  { subject: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);
export type ApproveRequest = Static<typeof ApproveRequest>;

export const DeclineRequest = Type.Object(
  { note: Type.Optional(Type.String({ maxLength: 4_000 })) },
  { additionalProperties: false },
);
export type DeclineRequest = Static<typeof DeclineRequest>;

export const InboxWorkspace = Type.Object({
  id: Type.String(),
  name: Type.String(),
  projectName: Type.String(),
  state: WorkspaceState,
});
export type InboxWorkspace = Static<typeof InboxWorkspace>;

/** The chat an item belongs to, so Home can name it and link to it. */
export const InboxChat = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  kind: ChatKind,
  active: Type.Boolean(),
});
export type InboxChat = Static<typeof InboxChat>;

/** Fields every Home item has. `at` is when it began to need the user; Home sorts newest first. */
const itemBase = {
  at: Type.Integer(),
  agentId: Type.String(),
  workspace: InboxWorkspace,
  chat: InboxChat,
};

/** One thing that needs the user on Home (R15.1). `finished`: the agent's last run ended and it waits for the user. */
export const InboxItem = Type.Union([
  Type.Object({ kind: Type.Literal("question"), ...itemBase, question: Question }),
  Type.Object({ kind: Type.Literal("approval"), ...itemBase, approval: Approval }),
  Type.Object({ kind: Type.Literal("dialog"), ...itemBase, dialog: AgentDialog }),
  Type.Object({ kind: Type.Literal("failed"), ...itemBase, error: Type.String() }),
  Type.Object({ kind: Type.Literal("finished"), ...itemBase }),
]);
export type InboxItem = Static<typeof InboxItem>;

export const RunningItem = Type.Object({
  agentId: Type.String(),
  workspace: InboxWorkspace,
  chat: InboxChat,
  status: Type.Union([AgentStatus, Type.Literal("helpers")]),
  /** Replaces the status text, e.g. "Waiting for <model>" from the router (R4.5). */
  detail: Type.Optional(Type.String()),
  since: Type.Integer(),
});
export type RunningItem = Static<typeof RunningItem>;

/** `interrupted` holds jobs a restart stopped part way. They are not items: they have no agent, chat, or workspace. */
export const Inbox = Type.Object({
  items: Type.Array(InboxItem),
  interrupted: Type.Array(Job),
  running: Type.Array(RunningItem),
});
export type Inbox = Static<typeof Inbox>;

/** The only event of topic `attention:inbox`: the whole inbox, on subscribe and after every change. */
export const InboxEvent = Type.Object({ type: Type.Literal("inbox"), inbox: Inbox });
export type InboxEvent = Static<typeof InboxEvent>;

/** What spore-bridge's `check` and `run_action` send to start a run. */
export const StartBridgeRunRequest = Type.Object(
  { action: Type.String({ pattern: "^[a-z0-9_-]{1,64}$" }) },
  { additionalProperties: false },
);
export type StartBridgeRunRequest = Static<typeof StartBridgeRunRequest>;

/** The end of a run's log for an agent, cut to a size a model can read. */
export const BridgeRunLog = Type.Object({
  run: ActionRun,
  text: Type.String(),
  truncated: Type.Boolean(),
});
export type BridgeRunLog = Static<typeof BridgeRunLog>;
