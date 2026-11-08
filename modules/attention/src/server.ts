import { AgentsKey } from "@pi-spore/mod-agents/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  type Agent,
  AnswerQuestionRequest,
  type Approval,
  ApproveRequest,
  DeclineRequest,
  type Inbox,
  type InboxChat,
  type InboxEvent,
  type InboxItem,
  type InboxWorkspace,
  parse,
  parseJsonBody,
  type Question,
  type RunningItem,
} from "@pi-spore/shared";
import {
  type ApprovalKind,
  type Approvals,
  ApprovalsKey,
  type Questions,
  QuestionsKey,
} from "./contract.js";

export * from "./contract.js";

export const INBOX_TOPIC = "attention:inbox";

const MIGRATIONS = [
  `CREATE TABLE attention_questions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    question TEXT NOT NULL,
    choices TEXT,
    state TEXT NOT NULL,
    answer TEXT,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  )`,
  "CREATE INDEX attention_questions_by_state ON attention_questions (state, created_at)",
  // ADR 0100: decision gates on Home.
  `CREATE TABLE attention_approvals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    subject TEXT NOT NULL,
    state TEXT NOT NULL,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  "CREATE INDEX attention_approvals_by_state ON attention_approvals (state, created_at)",
];

interface ApprovalRow {
  id: string;
  kind: string;
  agent_id: string;
  workspace_id: string;
  title: string;
  reason: string;
  /** JSON, written only by this module after the kind's schema checked it. */
  subject: string;
  state: Approval["state"];
  outcome: string | null;
  created_at: number;
  decided_at: number | null;
}

function toApproval(row: ApprovalRow): Approval {
  let subject: unknown;
  try {
    subject = JSON.parse(row.subject);
  } catch {
    throw new Error(`Approval ${row.id} has a broken subject in the store`);
  }
  return {
    id: row.id,
    kind: row.kind,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    title: row.title,
    reason: row.reason,
    subject,
    state: row.state,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    createdAt: row.created_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
  };
}

/** The message that tells the asking agent what the user decided. It names the request, so the agent can go on. */
export function decisionMessage(approval: Approval, approved: boolean, outcome: string): string {
  return [
    `The user ${approved ? "approved" : "declined"} your request (approval ${approval.id}).`,
    "",
    `Request: ${approval.title}`,
    "",
    approved
      ? `Outcome: ${outcome}`
      : outcome
        ? `The user's note: ${outcome}`
        : "The user gave no note.",
  ].join("\n");
}

interface Row {
  id: string;
  agent_id: string;
  workspace_id: string;
  question: string;
  /** A JSON array of strings, written only by this module. */
  choices: string | null;
  state: "open" | "answered" | "closed";
  answer: string | null;
  created_at: number;
  answered_at: number | null;
}

function readChoices(row: Row): string[] {
  try {
    return JSON.parse(row.choices ?? "[]") as string[];
  } catch {
    throw new Error(`Question ${row.id} has broken choices in the store`);
  }
}

const toQuestion = (row: Row): Question => ({
  id: row.id,
  agentId: row.agent_id,
  workspaceId: row.workspace_id,
  question: row.question,
  ...(row.choices === null ? {} : { choices: readChoices(row) }),
  state: row.state,
  ...(row.answer === null ? {} : { answer: row.answer }),
  createdAt: row.created_at,
  ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
});

const chatOf = (agent: Agent): InboxChat => ({
  id: agent.id,
  ...(agent.title === undefined ? {} : { title: agent.title }),
  kind: agent.kind,
  active: agent.active,
});

/** The message that brings the answer to the agent. It names the question, so the agent can resume from it alone. */
export function answerMessage(question: Question, answer: string): string {
  return [
    `The user answered your question (request_human_input, question ${question.id}).`,
    "",
    `Question: ${question.question}`,
    "",
    `Answer: ${answer}`,
  ].join("\n");
}

/**
 * Home (R15): questions from agents, and what needs the user across workspaces, built from the agents module's
 * state. Browsers follow topic `attention:inbox`, which sends the whole inbox after every change.
 */
export const attentionModule: ServerModule = {
  id: "attention",
  requires: ["projects", "workspaces", "agents"],
  core: true,
  setup(host) {
    host.store.migrate("attention", MIGRATIONS);
    const projects = host.use(ProjectsKey);
    const workspaces = host.use(WorkspacesKey);
    const agents = host.use(AgentsKey);

    const load = (id: string): Row => {
      const row = host.store.get<Row>("SELECT * FROM attention_questions WHERE id = ?", id);
      if (!row) throw new ApiError(404, "question_not_found", `No question ${id}`);
      return row;
    };

    const inbox = async (): Promise<Inbox> => {
      const projectNames = new Map(
        (await projects.list()).map((project) => [project.id, project.name]),
      );
      const places = new Map<string, InboxWorkspace>(
        workspaces.list().map((workspace) => [
          workspace.id,
          {
            id: workspace.id,
            name: workspace.name,
            projectName: projectNames.get(workspace.projectId) ?? workspace.projectId,
            state: workspace.state,
          },
        ]),
      );
      const all = agents.attention();
      const chats = new Map(all.map(({ agent }) => [agent.id, chatOf(agent)]));
      const open = host.store
        .all<Row>("SELECT * FROM attention_questions WHERE state = 'open'")
        .map(toQuestion);
      // An open question or approval already says why the agent stopped.
      const asking = new Set([
        ...open.map((question) => question.agentId),
        ...host.store
          .all<{ agent_id: string }>(
            "SELECT agent_id FROM attention_approvals WHERE state = 'open'",
          )
          .map((row) => row.agent_id),
      ]);
      const items: InboxItem[] = [];
      for (const question of open) {
        const workspace = places.get(question.workspaceId);
        const chat = chats.get(question.agentId);
        if (workspace && chat)
          items.push({
            kind: "question",
            at: question.createdAt,
            agentId: question.agentId,
            workspace,
            chat,
            question,
          });
      }
      for (const approval of host.store
        .all<ApprovalRow>("SELECT * FROM attention_approvals WHERE state = 'open'")
        .map(toApproval)) {
        const workspace = places.get(approval.workspaceId);
        const chat = chats.get(approval.agentId);
        if (workspace && chat)
          items.push({
            kind: "approval",
            at: approval.createdAt,
            agentId: approval.agentId,
            workspace,
            chat,
            approval,
          });
      }
      const running: RunningItem[] = [];
      for (const { agent, since, dialogs, waitingSince } of all) {
        const workspace = places.get(agent.workspaceId);
        if (!workspace) continue;
        const base = { agentId: agent.id, workspace, chat: chatOf(agent) };
        for (const { dialog, openedAt } of dialogs)
          items.push({ kind: "dialog", at: openedAt, ...base, dialog });
        if (agent.status === "failed")
          items.push({ kind: "failed", at: since, ...base, error: agent.error ?? "Agent failed" });
        else if (agent.status === "idle" && agent.helpersRunning)
          running.push({ ...base, status: "helpers", since });
        else if (
          waitingSince !== undefined &&
          !asking.has(agent.id) &&
          workspace.state === "active"
        )
          items.push({ kind: "finished", at: waitingSince, ...base });
        if (agent.status === "busy" || agent.status === "starting" || agent.status === "waiting")
          running.push({ ...base, status: agent.status, since });
      }
      items.sort((a, b) => b.at - a.at);
      running.sort((a, b) => b.since - a.since);
      const interrupted = host.jobs
        .list({ states: ["interrupted"] })
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return { items, interrupted, running };
    };

    // Many changes come in bursts (status, then dialog); one inbox per tick is enough.
    let scheduled = false;
    const changed = () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        inbox().then(
          (current) => host.events.publish(INBOX_TOPIC, { type: "inbox", inbox: current }),
          (error: unknown) => host.log.error("Home inbox failed", { error: String(error) }),
        );
      });
    };
    /**
     * ADR 0033: a question from a worker chat that is no longer active is closed. It stays in that chat's history;
     * after the chat is made active again, the user writes to it directly.
     */
    const closeQuestions = (agentId: string) => {
      const { changes } = host.store.run(
        "UPDATE attention_questions SET state = 'closed' WHERE agent_id = ? AND state = 'open'",
        agentId,
      );
      if (changes > 0)
        host.log.info("Closed the questions of an inactive chat", { agent: agentId });
    };
    host.jobs.onChange(changed);
    agents.onChange((agentId, change) => {
      if (change === "chat" && !agents.get(agentId).active) closeQuestions(agentId);
      changed();
    });
    // ADR 0121: what a deleted chat or workspace asked goes with it.
    const deleteWhere = (column: "agent_id" | "workspace_id", id: string) => {
      host.store.run(`DELETE FROM attention_questions WHERE ${column} = ?`, id);
      host.store.run(`DELETE FROM attention_approvals WHERE ${column} = ?`, id);
      changed();
    };
    agents.beforeDeleteChat((agentId) => deleteWhere("agent_id", agentId));
    workspaces.beforeDeleteWorkspace(async (workspace) =>
      deleteWhere("workspace_id", workspace.id),
    );
    host.events.onSubscribe(
      INBOX_TOPIC,
      async (): Promise<InboxEvent[]> => [{ type: "inbox", inbox: await inbox() }],
    );

    const questions: Questions = {
      file: (caller, request) => {
        const workspace = workspaces.get(caller.workspaceId);
        const row: Row = {
          id: host.newId(),
          agent_id: caller.agentId,
          workspace_id: workspace.id,
          question: request.question,
          choices: request.choices ? JSON.stringify(request.choices) : null,
          state: "open",
          answer: null,
          created_at: host.now(),
          answered_at: null,
        };
        host.store.run(
          `INSERT INTO attention_questions (id, agent_id, workspace_id, question, choices, state, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?)`,
          row.id,
          row.agent_id,
          row.workspace_id,
          row.question,
          row.choices,
          row.created_at,
        );
        changed();
        return toQuestion(row);
      },
    };
    host.provide(QuestionsKey, questions);

    const kinds = new Map<string, ApprovalKind>();
    const loadApproval = (id: string): ApprovalRow => {
      const row = host.store.get<ApprovalRow>("SELECT * FROM attention_approvals WHERE id = ?", id);
      if (!row) throw new ApiError(404, "approval_not_found", `No approval ${id}`);
      return row;
    };
    const kindOf = (name: string): ApprovalKind => {
      const kind = kinds.get(name);
      if (!kind) {
        throw new ApiError(
          409,
          "approval_kind_unknown",
          `No enabled module handles "${name}" approvals; decline it instead`,
        );
      }
      return kind;
    };
    const approvals: Approvals = {
      register: (kind) => {
        if (kinds.has(kind.kind))
          throw new Error(`Approval kind "${kind.kind}" is registered twice`);
        // SAFETY: every subject is parsed with this kind's own schema before approve() sees it.
        kinds.set(kind.kind, kind as unknown as ApprovalKind);
      },
      file: (caller, request) => {
        const kind = kindOf(request.kind);
        const subject = parse(kind.subject, request.subject, `${request.kind} approval`);
        const workspace = workspaces.get(caller.workspaceId);
        const row: ApprovalRow = {
          id: host.newId(),
          kind: kind.kind,
          agent_id: caller.agentId,
          workspace_id: workspace.id,
          title: request.title,
          reason: request.reason,
          subject: JSON.stringify(subject),
          state: "open",
          outcome: null,
          created_at: host.now(),
          decided_at: null,
        };
        host.store.run(
          `INSERT INTO attention_approvals (id, kind, agent_id, workspace_id, title, reason, subject, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          row.id,
          row.kind,
          row.agent_id,
          row.workspace_id,
          row.title,
          row.reason,
          row.subject,
          row.created_at,
        );
        changed();
        return toApproval(row);
      },
    };
    host.provide(ApprovalsKey, approvals);

    /** Approvals being carried out, so a second click does not start the work twice. */
    const deciding = new Set<string>();
    const openApproval = (id: string): ApprovalRow => {
      const row = loadApproval(id);
      if (row.state !== "open")
        throw new ApiError(409, "approval_decided", `That approval was already ${row.state}`);
      if (deciding.has(row.id))
        throw new ApiError(409, "approval_deciding", "That approval is being carried out");
      return row;
    };
    /** Stores the decision and queues it for the asking agent in one transaction (architecture 6). */
    const decide = (row: ApprovalRow, approved: boolean, subject: string, outcome: string) =>
      host.store.transaction(() => {
        const now = host.now();
        const state = approved ? "approved" : "declined";
        host.store.run(
          "UPDATE attention_approvals SET state = ?, subject = ?, outcome = ?, decided_at = ? WHERE id = ?",
          state,
          subject,
          outcome === "" ? null : outcome,
          now,
          row.id,
        );
        const decided = toApproval({
          ...row,
          state,
          subject,
          outcome: outcome === "" ? null : outcome,
          decided_at: now,
        });
        agents.deliver(row.agent_id, decisionMessage(decided, approved, outcome));
        return decided;
      });

    host.routes.get("/approvals", (c) => {
      const state = c.req.query("state");
      if (state !== undefined && !["open", "approved", "declined"].includes(state))
        throw new ApiError(400, "bad_query", '"state" must be open, approved, or declined');
      const rows = state
        ? host.store.all<ApprovalRow>(
            "SELECT * FROM attention_approvals WHERE state = ? ORDER BY created_at DESC",
            state,
          )
        : host.store.all<ApprovalRow>("SELECT * FROM attention_approvals ORDER BY created_at DESC");
      return c.json({ approvals: rows.map(toApproval) });
    });

    host.routes.get("/approvals/:id", (c) =>
      c.json({ approval: toApproval(loadApproval(c.req.param("id"))) }),
    );

    host.routes.post("/approvals/:id/approve", async (c) => {
      const request = parseJsonBody(ApproveRequest, await c.req.text(), "approve request");
      const row = openApproval(c.req.param("id"));
      const kind = kindOf(row.kind);
      const subject = parse(
        kind.subject,
        request.subject === undefined ? toApproval(row).subject : request.subject,
        `${row.kind} approval`,
      );
      deciding.add(row.id);
      let outcome: string;
      try {
        outcome = await kind.approve(subject, toApproval(row));
      } finally {
        deciding.delete(row.id);
      }
      const approval = decide(row, true, JSON.stringify(subject), outcome);
      changed();
      return c.json({ approval });
    });

    host.routes.post("/approvals/:id/decline", async (c) => {
      const request = parseJsonBody(DeclineRequest, await c.req.text(), "decline request");
      const row = openApproval(c.req.param("id"));
      const approval = decide(row, false, row.subject, request.note?.trim() ?? "");
      changed();
      return c.json({ approval });
    });

    host.routes.get("/inbox", async (c) => c.json(await inbox()));

    host.routes.get("/questions/:id", (c) =>
      c.json({ question: toQuestion(load(c.req.param("id"))) }),
    );

    /** Stores the answer and queues it for the agent in one transaction (architecture 6). */
    host.routes.post("/questions/:id/answer", async (c) => {
      const request = parseJsonBody(AnswerQuestionRequest, await c.req.text(), "answer");
      const question = host.store.transaction(() => {
        const row = load(c.req.param("id"));
        if (row.state === "closed") {
          throw new ApiError(
            409,
            "question_closed",
            "That question was closed: its chat is no longer the active orchestrator chat",
          );
        }
        if (row.state !== "open")
          throw new ApiError(409, "question_answered", "That question already has an answer");
        const now = host.now();
        host.store.run(
          "UPDATE attention_questions SET state = 'answered', answer = ?, answered_at = ? WHERE id = ?",
          request.answer,
          now,
          row.id,
        );
        const answered = toQuestion({
          ...row,
          state: "answered",
          answer: request.answer,
          answered_at: now,
        });
        agents.deliver(row.agent_id, answerMessage(answered, request.answer));
        return answered;
      });
      changed();
      return c.json({ question });
    });
  },
};
