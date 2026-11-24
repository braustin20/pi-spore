import Type, { type Static } from "typebox";
import { ActionRun } from "./actions.js";
import { AgentDialog, AgentStatus, ChatKind } from "./agents.js";
import { ArtifactScope } from "./artifacts.js";
import { Job } from "./jobs.js";
import { WorkspaceState } from "./workspaces.js";

/** One option of a `select` or `multiselect` step. `description` and `preview` are Markdown. */
export const QuestionOption = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 1_000 })),
    preview: Type.Optional(Type.String({ maxLength: 4_000 })),
  },
  { additionalProperties: false },
);
export type QuestionOption = Static<typeof QuestionOption>;

/** Markdown. */
const prompt = Type.String({ minLength: 1, maxLength: 4_000 });
const choiceStep = <T extends "select" | "multiselect">(type: T) =>
  Type.Object(
    {
      type: Type.Literal(type),
      prompt,
      options: Type.Array(QuestionOption, { minItems: 2, maxItems: 8 }),
      /** Index into `options` of the option the agent recommends. Advice only. */
      recommended: Type.Optional(Type.Integer({ minimum: 0 })),
      /** The user may answer in their own words. */
      allowOther: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );

/** One step of a question. The user answers every step, in order, before the agent gets anything. */
export const QuestionStep = Type.Union([
  Type.Object({ type: Type.Literal("text"), prompt }, { additionalProperties: false }),
  choiceStep("select"),
  choiceStep("multiselect"),
  Type.Object(
    {
      type: Type.Literal("confirm"),
      prompt,
      /** The answer the agent recommends. Advice only. */
      recommended: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);
export type QuestionStep = Static<typeof QuestionStep>;

/**
 * A file the user should read before answering (ADR 0200): the same scope and relative path `artifacts_write`
 * takes. `label` is the text of its Read button; the UI falls back to the file name.
 */
export const QuestionArtifact = Type.Object(
  {
    scope: ArtifactScope,
    path: Type.String({ minLength: 1, maxLength: 255 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  },
  { additionalProperties: false },
);
export type QuestionArtifact = Static<typeof QuestionArtifact>;

/** A {@link QuestionArtifact} on a stored question, with the folder that owns the file: a workspace or project id. */
export const LinkedArtifact = Type.Object(
  { ...QuestionArtifact.properties, ownerId: Type.String() },
  { additionalProperties: false },
);
export type LinkedArtifact = Static<typeof LinkedArtifact>;

const answerText = Type.String({ minLength: 1, maxLength: 20_000 });

/** The user's answer to one step. The server checks it against the step (exactly one of `label` and `other`). */
export const StepAnswer = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: answerText }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("select"),
      label: Type.Optional(Type.String()),
      other: Type.Optional(answerText),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("multiselect"),
      labels: Type.Array(Type.String()),
      other: Type.Optional(answerText),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("confirm"), yes: Type.Boolean() },
    { additionalProperties: false },
  ),
]);
export type StepAnswer = Static<typeof StepAnswer>;

/**
 * A question an agent filed for the user with `request_human_input` (R3.5, ADR 0008). `closed`: its chat stopped
 * being the active worker chat before an answer came (ADR 0033). `steps` is always set: an old-form question is one
 * step. `question` is the first step's prompt; `choices` and `recommended` are set only for the old form.
 */
export const Question = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  workspaceId: Type.String(),
  question: Type.String(),
  choices: Type.Optional(Type.Array(Type.String())),
  /** Index into `choices` of the choice the agent recommends. Advice only. */
  recommended: Type.Optional(Type.Integer({ minimum: 0 })),
  steps: Type.Array(QuestionStep),
  /** Files to read first, each with its owner id (ADR 0200). Absent for a question that links none. */
  artifacts: Type.Optional(Type.Array(LinkedArtifact)),
  state: Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("closed")]),
  answer: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
  answeredAt: Type.Optional(Type.Integer()),
});
export type Question = Static<typeof Question>;

/**
 * What spore-bridge's `request_human_input` sends: `steps`, or the old form `question`, `choices`, and
 * `recommended`. The attention module checks that exactly one form is used.
 */
export const FileQuestionRequest = Type.Object(
  {
    question: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
    choices: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 8 }),
    ),
    /** Index into `choices` of the choice the agent recommends. Advice only. */
    recommended: Type.Optional(Type.Integer({ minimum: 0 })),
    steps: Type.Optional(Type.Array(QuestionStep, { minItems: 1, maxItems: 6 })),
    /** Files the user should read first. The bridge checks they exist before it files the question. */
    artifacts: Type.Optional(Type.Array(QuestionArtifact, { minItems: 1, maxItems: 6 })),
  },
  { additionalProperties: false },
);
export type FileQuestionRequest = Static<typeof FileQuestionRequest>;

/** `answer`: free text, for a one-step question only. `answers`: one per step, in order. */
export const AnswerQuestionRequest = Type.Union([
  Type.Object({ answer: answerText }, { additionalProperties: false }),
  Type.Object(
    { answers: Type.Array(StepAnswer, { minItems: 1, maxItems: 6 }) },
    { additionalProperties: false },
  ),
]);
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

/**
 * What a module's Home source reports (ADR 0155). `id` is stable while the condition lasts and unique within the
 * source. `href` is a web route (`#/board`) that opens the thing that needs the user. `at` is when it began to.
 */
const noticeFields = {
  id: Type.String(),
  at: Type.Integer(),
  title: Type.String(),
  detail: Type.Optional(Type.String()),
  href: Type.String(),
};
export const HomeNotice = Type.Object(noticeFields);
export type HomeNotice = Static<typeof HomeNotice>;

/**
 * One thing that needs the user on Home (R15.1). `finished`: the agent's last run ended and it waits for the user.
 * `notice`: a module's own item, such as a PR that waits or a card that is overdue. It has no chat.
 */
export const InboxItem = Type.Union([
  Type.Object({ kind: Type.Literal("question"), ...itemBase, question: Question }),
  Type.Object({ kind: Type.Literal("approval"), ...itemBase, approval: Approval }),
  Type.Object({ kind: Type.Literal("dialog"), ...itemBase, dialog: AgentDialog }),
  Type.Object({ kind: Type.Literal("failed"), ...itemBase, error: Type.String() }),
  Type.Object({ kind: Type.Literal("finished"), ...itemBase }),
  Type.Object({ kind: Type.Literal("notice"), source: Type.String(), ...noticeFields }),
]);
export type InboxItem = Static<typeof InboxItem>;

/**
 * One running workspace for Home (`running`, R15.1). Home shows one row per workspace, so `chat` is the chat that
 * row stands for: a working stage first, then a stage that waits for a worker slot, then the active worker chat.
 */
export const RunningItem = Type.Object({
  agentId: Type.String(),
  workspace: InboxWorkspace,
  chat: InboxChat,
  status: Type.Union([AgentStatus, Type.Literal("helpers"), Type.Literal("pipeline")]),
  /** Replaces the status text, e.g. "Waiting for <model>" from the router (R4.5). */
  detail: Type.Optional(Type.String()),
  /** What the row's chat did last, from the agents module (R15). */
  activity: Type.Optional(Type.String()),
  /** Other chats of the workspace that work too; a worker that only waits for its stage is out. */
  others: Type.Optional(Type.Integer({ minimum: 1 })),
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

/** One key per thing that needs the user, stable across inbox updates. */
export function itemKey(item: InboxItem): string {
  switch (item.kind) {
    case "question":
      return `question:${item.question.id}`;
    case "approval":
      return `approval:${item.approval.id}`;
    case "dialog":
      return `dialog:${item.agentId}:${item.dialog.id}`;
    case "notice":
      return `notice:${item.source}:${item.id}`;
    default:
      return `${item.kind}:${item.agentId}:${item.at}`;
  }
}

/** The title and body of a notification for an item (R15.2): a desktop one, or a phone push (ADR 0196). */
export function notification(item: InboxItem): { title: string; body: string } {
  if (item.kind === "notice") return { title: item.title, body: item.detail ?? "" };
  const chat = item.chat.title ? `, ${item.chat.title}` : "";
  const where = `${item.workspace.name} (${item.workspace.projectName}${chat})`;
  switch (item.kind) {
    case "question":
      return { title: `Question from ${where}`, body: item.question.question };
    case "approval":
      return { title: `${where} asks for approval`, body: item.approval.title };
    case "dialog":
      return {
        title: `${where} asks`,
        body: item.dialog.title ?? item.dialog.message ?? "An extension dialog is open",
      };
    case "failed":
      return { title: `Agent failed in ${where}`, body: item.error.split("\n")[0] ?? "" };
    case "finished":
      return { title: `${where} is done`, body: "The agent finished and waits for you." };
  }
}

/** Where an item leads: the link of a notice, else its chat, `#/workspaces/<workspace>/chats/<chat>`. */
export const itemHref = (item: InboxItem): string =>
  item.kind === "notice" ? item.href : `#/workspaces/${item.workspace.id}/chats/${item.chat.id}`;

const pushKey = Type.String({ minLength: 1, maxLength: 512 });

/** A browser's push subscription (ADR 0196), as `PushSubscription.toJSON()` gives it. */
export const PushSubscriptionRequest = Type.Object({
  // A whole https URL: a host of letters, digits, dots, and dashes, an optional port, then an optional path.
  endpoint: Type.String({
    pattern: "^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^\\s]*)?$",
    maxLength: 2_048,
  }),
  keys: Type.Object({ p256dh: pushKey, auth: pushKey }),
});
export type PushSubscriptionRequest = Static<typeof PushSubscriptionRequest>;

export const PushUnsubscribeRequest = Type.Object(
  { endpoint: Type.String({ minLength: 1, maxLength: 2_048 }) },
  { additionalProperties: false },
);
export type PushUnsubscribeRequest = Static<typeof PushUnsubscribeRequest>;

/** A desktop page reports its focus; while one has focus, no push goes out (ADR 0196). */
export const PushFocusRequest = Type.Object(
  { page: Type.String({ minLength: 1, maxLength: 64 }), focused: Type.Boolean() },
  { additionalProperties: false },
);
export type PushFocusRequest = Static<typeof PushFocusRequest>;

/** All a push carries (ADR 0196). `badge`: the Home count. */
export interface PushPayload {
  title: string;
  body: string;
  href: string;
  tag: string;
  badge: number;
}

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
