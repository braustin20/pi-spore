import { AgentsKey } from "@pi-spore/mod-agents/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  AnswerQuestionRequest,
  type Inbox,
  type InboxEvent,
  type InboxItem,
  type InboxWorkspace,
  parseJsonBody,
  type Question,
  type RunningItem,
} from "@pi-spore/shared";
import { type Questions, QuestionsKey } from "./contract.js";

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
];

interface Row {
  id: string;
  agent_id: string;
  workspace_id: string;
  question: string;
  /** A JSON array of strings, written only by this module. */
  choices: string | null;
  state: "open" | "answered";
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
      const open = host.store
        .all<Row>("SELECT * FROM attention_questions WHERE state = 'open'")
        .map(toQuestion);
      const asking = new Set(open.map((question) => question.agentId));
      const items: InboxItem[] = [];
      for (const question of open) {
        const workspace = places.get(question.workspaceId);
        if (workspace)
          items.push({
            kind: "question",
            at: question.createdAt,
            agentId: question.agentId,
            workspace,
            question,
          });
      }
      const running: RunningItem[] = [];
      for (const { agent, since, dialogs, waitingSince } of agents.attention()) {
        const workspace = places.get(agent.workspaceId);
        if (!workspace) continue;
        const base = { agentId: agent.id, workspace };
        for (const { dialog, openedAt } of dialogs)
          items.push({ kind: "dialog", at: openedAt, ...base, dialog });
        if (agent.status === "failed")
          items.push({ kind: "failed", at: since, ...base, error: agent.error ?? "Agent failed" });
        // An open question already says why the agent stopped.
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
      return { items, running };
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
    agents.onChange(changed);
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

    host.routes.get("/inbox", async (c) => c.json(await inbox()));

    host.routes.get("/questions/:id", (c) =>
      c.json({ question: toQuestion(load(c.req.param("id"))) }),
    );

    /** Stores the answer and queues it for the agent in one transaction (architecture 6). */
    host.routes.post("/questions/:id/answer", async (c) => {
      const request = parseJsonBody(AnswerQuestionRequest, await c.req.text(), "answer");
      const question = host.store.transaction(() => {
        const row = load(c.req.param("id"));
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
