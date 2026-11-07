import Type, { type Static } from "typebox";
import { ActionRun } from "./actions.js";
import { AgentDialog, AgentStatus } from "./agents.js";
import { WorkspaceState } from "./workspaces.js";

/** A question an agent filed for the user with `request_human_input` (R3.5, ADR 0008). */
export const Question = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  workspaceId: Type.String(),
  question: Type.String(),
  choices: Type.Optional(Type.Array(Type.String())),
  state: Type.Union([Type.Literal("open"), Type.Literal("answered")]),
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

export const InboxWorkspace = Type.Object({
  id: Type.String(),
  name: Type.String(),
  projectName: Type.String(),
  state: WorkspaceState,
});
export type InboxWorkspace = Static<typeof InboxWorkspace>;

/** Fields every Home item has. `at` is when it began to need the user; Home sorts newest first. */
const itemBase = {
  at: Type.Integer(),
  agentId: Type.String(),
  workspace: InboxWorkspace,
};

/** One thing that needs the user on Home (R15.1). `finished`: the agent's last run ended and it waits for the user. */
export const InboxItem = Type.Union([
  Type.Object({ kind: Type.Literal("question"), ...itemBase, question: Question }),
  Type.Object({ kind: Type.Literal("dialog"), ...itemBase, dialog: AgentDialog }),
  Type.Object({ kind: Type.Literal("failed"), ...itemBase, error: Type.String() }),
  Type.Object({ kind: Type.Literal("finished"), ...itemBase }),
]);
export type InboxItem = Static<typeof InboxItem>;

export const RunningItem = Type.Object({
  agentId: Type.String(),
  workspace: InboxWorkspace,
  status: AgentStatus,
  since: Type.Integer(),
});
export type RunningItem = Static<typeof RunningItem>;

export const Inbox = Type.Object({
  items: Type.Array(InboxItem),
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
