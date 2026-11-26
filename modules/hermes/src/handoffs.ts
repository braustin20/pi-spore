import { AgentsKey } from "@pi-spore/mod-agents/server";
import { HomeItemsKey } from "@pi-spore/mod-attention/server";
import type { HermesAsker } from "@pi-spore/mod-bridge/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import {
  ApiError,
  type BridgeCaller,
  type ServerHost,
  type StepOutcome,
} from "@pi-spore/module-api";
import {
  AnswerHermesControlRequest,
  type AskHermesRequest,
  type HermesControl,
  type HermesHandoff,
  type HermesHandoffState,
  type HermesReconcile,
  parseJsonBody,
  ResolveHermesHandoffRequest,
} from "@pi-spore/shared";
import Type from "typebox";
import type { Hermes, Run, RunEvent } from "./contract.js";

const JOB = "hermes.ask";
const ENDED: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "uncertain"]);
/** The first wait after Hermes did not answer; it doubles up to `MAX_BACKOFF_MS`. Same as the status poll. */
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;
/** How much of a result goes into the delivered message. The full result stays on the handoff. */
const MESSAGE_CAP = 4_000;
/** How much of one session message the reconcile view shows. */
const FACT_CAP = 1_000;

/** Hermes run status to handoff state (card Hermes 1.2). `waiting_for_approval` is running with an open control. */
const STATE_OF: Record<Run["status"], HermesHandoffState> = {
  queued: "accepted",
  running: "running",
  waiting_for_approval: "running",
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
  interrupted: "cancelled",
  unknown: "uncertain",
};

type Ended = "completed" | "cancelled" | "failed" | "uncertain";
interface End {
  state: Ended;
  result?: string;
  error?: string;
}
/**
 * `tries` counts waits in a row, for the backoff, and `since` is when they began; `end` is what the deliver step
 * stores. A step that moves on writes a fresh one, since the runner keeps the old checkpoint otherwise.
 */
type Checkpoint = { tries?: number; since?: number; end?: End };

interface Row {
  id: string;
  agent_id: string;
  workspace_id: string;
  project_id: string;
  profile: string;
  kind: "question" | "task";
  title: string | null;
  text: string;
  prompt: string;
  hop_count: number;
  state: HermesHandoffState;
  run_key: string;
  run_id: string | null;
  session_id: string | null;
  admission_id: string | null;
  execution_generation: number | null;
  idempotency_key: string;
  job_id: string | null;
  provider: string | null;
  model: string | null;
  last_event_id: string | null;
  tool_started: string | null;
  tool_finished: string | null;
  cancel_requested: number;
  result_text: string | null;
  error: string | null;
  resolution: "interrupted" | "resent" | "dropped" | null;
  resent_as: string | null;
  created_at: number;
  updated_at: number;
}

interface ControlRow {
  handoff_id: string;
  prompt_id: string;
  kind: "approval" | "clarify";
  command: string | null;
  description: string | null;
  question: string | null;
  execution_generation: number;
  state: HermesControl["state"];
  created_at: number;
}

export const HANDOFF_MIGRATIONS = [
  `CREATE TABLE hermes_handoffs (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    prompt TEXT NOT NULL,
    hop_count INTEGER NOT NULL,
    state TEXT NOT NULL,
    run_key TEXT NOT NULL,
    run_id TEXT,
    session_id TEXT,
    admission_id TEXT,
    execution_generation INTEGER,
    idempotency_key TEXT NOT NULL,
    job_id TEXT,
    provider TEXT,
    model TEXT,
    last_event_id TEXT,
    tool_started TEXT,
    tool_finished TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    result_text TEXT,
    error TEXT,
    resolution TEXT,
    resent_as TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX hermes_handoffs_receipt ON hermes_handoffs (agent_id, idempotency_key);
  CREATE TABLE hermes_controls (
    handoff_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    command TEXT,
    description TEXT,
    question TEXT,
    execution_generation INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (handoff_id, prompt_id)
  );`,
];

const cap = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}... (cut at ${max} characters)`;

/**
 * Handoffs from Pi chats to Hermes (ADR 0202, card Hermes 1.2): the `hermes_handoffs` rows, the `hermes.ask` job that
 * submits, follows, and delivers each one, the user's routes for cancel, approvals, clarify, and uncertain runs, and
 * the Home items that send the user there. Nothing here answers a control or resolves a run on its own.
 */
export function setupHandoffs(
  host: ServerHost,
  hermes: Hermes,
  profileName: () => Promise<string>,
): HermesAsker {
  const agents = host.use(AgentsKey);
  const workspaces = host.use(WorkspacesKey);
  const projects = host.use(ProjectsKey);
  const homeItems = host.use(HomeItemsKey);
  const { store } = host;
  store.migrate("hermes", HANDOFF_MIGRATIONS);

  const offlineHours = host.settings.declare({
    key: "hermes.offlineWaitHours",
    // 24 h is also how long Hermes keeps an Idempotency-Key, so a late retry still dedupes.
    schema: Type.Integer({ minimum: 1, maximum: 24 }),
    default: 24,
    scope: "global",
  });
  const approvalSeconds = host.settings.declare({
    key: "hermes.approvalTimeoutSeconds",
    // Hermes's `approvals.timeout`; pi-spore cannot read Hermes's config, so it is set here to match.
    schema: Type.Integer({ minimum: 1 }),
    default: 300,
    scope: "global",
  });

  const load = (id: string) => store.get<Row>("SELECT * FROM hermes_handoffs WHERE id = ?", id);
  const update = (id: string, fields: Partial<Row>) => {
    const names = Object.keys(fields);
    store.run(
      `UPDATE hermes_handoffs SET ${names.map((name) => `${name} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ...names.map((name) => fields[name as keyof Row] as string | number | null),
      host.now(),
      id,
    );
  };
  const controlsOf = (id: string) =>
    store.all<ControlRow>(
      "SELECT * FROM hermes_controls WHERE handoff_id = ? ORDER BY created_at, prompt_id",
      id,
    );

  const timeoutMs = async () => (await host.settings.resolve()).get(approvalSeconds).value * 1000;

  const view = (row: Row, timeout: number): HermesHandoff => {
    const optional = (value: string | null) => value ?? undefined;
    const fields = {
      title: optional(row.title),
      runId: optional(row.run_id),
      sessionId: optional(row.session_id),
      provider: optional(row.provider),
      model: optional(row.model),
      result: optional(row.result_text),
      error: optional(row.error),
      resolution: optional(row.resolution),
      resentAs: optional(row.resent_as),
    };
    return {
      id: row.id,
      direction: "out",
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      profile: row.profile,
      kind: row.kind,
      text: row.text,
      state: row.state,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      controls: controlsOf(row.id).map((control) => ({
        promptId: control.prompt_id,
        kind: control.kind,
        ...(control.command === null ? {} : { command: control.command }),
        ...(control.description === null ? {} : { description: control.description }),
        ...(control.question === null ? {} : { question: control.question }),
        state: control.state,
        createdAt: control.created_at,
        expiresAt: control.created_at + timeout,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  const viewOf = async (row: Row) => view(row, await timeoutMs());

  const message = (row: Row, end: End) => {
    const lines = [`Hermes answered your ask_hermes ${row.id} (${end.state}):`];
    const body = end.result ?? end.error;
    if (body) {
      lines[0] += ` ${cap(body, MESSAGE_CAP)}`;
      if (body.length > MESSAGE_CAP)
        lines.push(
          "The full result is stored with the handoff; the user can read it on pi-spore's Hermes handoffs page.",
        );
    }
    if (end.state === "uncertain")
      lines.push(
        "Hermes lost track of the run (a restart or a stop it did not confirm). The user decides on pi-spore's Hermes handoffs page what happens next.",
      );
    if (row.cancel_requested === 1)
      lines.push("It was cancelled. Steps Hermes completed are not undone.");
    else if (end.state !== "completed")
      lines.push("Side effects that already happened in Hermes are not undone.");
    return lines.join("\n");
  };

  /**
   * Stores the end state and delivers the one message in the same transaction (architecture 6). A handoff that
   * already ended is left as it is, so no path delivers twice.
   */
  const finish = (id: string, end: End): boolean => {
    let ended = false;
    store.transaction(() => {
      const row = load(id);
      if (!row || ENDED.has(row.state)) return;
      update(id, {
        state: end.state,
        result_text: end.result ?? null,
        error: end.error ?? null,
      });
      store.run(
        "UPDATE hermes_controls SET state = 'expired', updated_at = ? WHERE handoff_id = ? AND state = 'open'",
        host.now(),
        id,
      );
      agents.deliver(row.agent_id, message(row, end));
      ended = true;
    });
    if (ended) homeItems.changed();
    return ended;
  };

  /** Makes the stored controls match the run's `pending_controls`. Controls the run no longer waits on expire. */
  const syncControls = (row: Row, run: Run) => {
    const pending = run.pending_controls ?? [];
    const now = host.now();
    let changed = false;
    store.transaction(() => {
      for (const control of pending) {
        const kind =
          control.kind === "clarify" || control.question !== undefined ? "clarify" : "approval";
        changed =
          store.run(
            `INSERT OR IGNORE INTO hermes_controls (handoff_id, prompt_id, kind, command, description, question,
             execution_generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
            row.id,
            control.prompt_id,
            kind,
            control.command ?? null,
            control.description ?? null,
            control.question ?? null,
            run.execution_generation ?? row.execution_generation ?? 0,
            now,
            now,
          ).changes > 0 || changed;
      }
      const open = new Set(pending.map((control) => control.prompt_id));
      for (const control of controlsOf(row.id))
        if (control.state === "open" && !open.has(control.prompt_id)) {
          store.run(
            "UPDATE hermes_controls SET state = 'expired', updated_at = ? WHERE handoff_id = ? AND prompt_id = ?",
            now,
            row.id,
            control.prompt_id,
          );
          changed = true;
        }
    });
    if (changed) homeItems.changed();
  };

  /** Stores what the run status says. Returns the end when the run has ended or is `unknown`. */
  const syncRun = (row: Row, run: Run): End | undefined => {
    const state = STATE_OF[run.status];
    syncControls(row, run);
    const fields: Partial<Row> = {
      ...(run.admission_id === undefined ? {} : { admission_id: run.admission_id }),
      ...(run.execution_generation === undefined
        ? {}
        : { execution_generation: run.execution_generation }),
    };
    if (!ENDED.has(state)) fields.state = state;
    if (Object.keys(fields).length > 0) update(row.id, fields);
    if (!ENDED.has(state)) return undefined;
    if (state === "completed") return { state, result: run.output ?? "" };
    if (state === "uncertain")
      return {
        state,
        error: "Hermes restarted during the run; whether its last step finished is not known.",
      };
    return { state: state as Ended, ...(run.output ? { result: run.output } : {}) };
  };

  const backoff = (tries: number) => Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** tries);
  const deliverWith = (end: End): StepOutcome<Checkpoint> => ({
    next: "deliver",
    checkpoint: { end },
  });

  /**
   * Waits while Hermes cannot be reached, up to `hermes.offlineWaitHours`: from the ask for a handoff not sent yet,
   * from the first failed try for a run being followed.
   */
  const waitOrFail = async (
    row: Row,
    step: "submit" | "follow",
    { tries = 0, since }: Checkpoint,
    error: ApiError,
  ): Promise<StepOutcome<Checkpoint>> => {
    const hours = (await host.settings.resolve()).get(offlineHours).value;
    const start = since ?? (step === "submit" ? row.created_at : host.now());
    if (host.now() - start >= hours * 3_600_000)
      return deliverWith({
        state: row.run_id ? "uncertain" : "failed",
        error: `Hermes could not be reached for ${hours} h: ${error.message}`,
      });
    return {
      next: step,
      after: backoff(tries),
      checkpoint: { tries: tries + 1, since: start },
      commit: () => update(row.id, { error: `Hermes is offline: ${error.message}` }),
    };
  };
  /** Errors that mean "try again later": Hermes is off, down, slow, or answered with a server error. */
  const transient = (error: unknown): error is ApiError =>
    error instanceof ApiError && (error.status >= 500 || error.code === "hermes_run_not_found");

  const submit = async (id: string, checkpoint: Checkpoint): Promise<StepOutcome<Checkpoint>> => {
    const row = load(id);
    if (!row || ENDED.has(row.state)) return { next: null };
    if (row.run_id) return { next: "follow", checkpoint: {} };
    try {
      if (!row.session_id) {
        const name = `pi-spore-${row.id}`;
        try {
          const session = await hermes.createSession({ id: name, title: row.title ?? name });
          update(id, {
            session_id: session.id,
            provider: session.billing_provider || null,
            model: session.model || null,
          });
        } catch (error) {
          // An earlier try made it and lost the answer. It is ours: no other client names sessions this way.
          if (!(error instanceof ApiError && error.code === "hermes_session_exists")) throw error;
          update(id, { session_id: name });
        }
      }
      // The same key and the identical body on every try, so Hermes starts the run at most once (spike Q2).
      const admission = await hermes.startRun(
        { input: row.prompt, session_id: `pi-spore-${row.id}` },
        row.run_key,
      );
      if (load(id)?.cancel_requested === 1)
        await hermes.stop(admission.run_id).catch(() => undefined);
      return {
        next: "follow",
        checkpoint: {},
        commit: () =>
          update(id, {
            run_id: admission.run_id,
            state: "accepted",
            error: null,
            session_id: `pi-spore-${row.id}`,
          }),
      };
    } catch (error) {
      if (transient(error)) return await waitOrFail(row, "submit", checkpoint, error);
      return deliverWith({ state: "failed", error: (error as Error).message });
    }
  };

  /** Handles one event. Returns the end once the run ended. */
  const onEvent = async (row: Row, event: RunEvent): Promise<End | undefined> => {
    switch (event.event) {
      case "tool.started":
        update(row.id, {
          tool_started: event.preview ? `${event.tool}: ${event.preview}` : event.tool,
          state: "running",
        });
        return undefined;
      case "tool.completed":
      case "tool.failed": {
        const failed = event.event === "tool.failed" || event.error === true;
        update(row.id, {
          tool_finished: `${event.tool ?? load(row.id)?.tool_started ?? "a tool"}${failed ? " (error)" : ""}`,
        });
        return undefined;
      }
      case "approval.request":
      case "approval.responded":
      case "clarify.request":
      case "run.completed":
      case "run.cancelled":
      case "run.failed":
      case "run.interrupted":
      case "replay.truncated":
        return syncRun(row, await hermes.getRun(row.run_id as string));
      default:
        if (row.state === "accepted") update(row.id, { state: "running" });
        return undefined;
    }
  };

  const follow = async (id: string, checkpoint: Checkpoint): Promise<StepOutcome<Checkpoint>> => {
    const row = load(id);
    if (!row || ENDED.has(row.state) || !row.run_id) return { next: null };
    const runId = row.run_id;
    // Frames came in on this try, so the waits before it no longer count.
    let reached = false;
    try {
      // The status first: after a restart, a lost stream, or a 404 on events, it is the truth (spike Q4).
      const first = syncRun(row, await hermes.getRun(runId));
      if (first) return deliverWith(first);
      let last = row.last_event_id ?? undefined;
      while (true) {
        let progressed = false;
        try {
          for await (const frame of hermes.runEvents(runId, last)) {
            progressed = true;
            reached = true;
            if (frame.id !== undefined) {
              last = frame.id;
              update(id, { last_event_id: last });
            }
            const end = await onEvent(load(id) as Row, frame.event);
            if (end) return deliverWith(end);
          }
          // A terminal frame whose status read did not end the run: read again on the next try.
          return { next: "follow", after: backoff(0), checkpoint: {} };
        } catch (error) {
          // A drop after some frames resumes at once; a drop with none waits, so a dead stream does not spin.
          if (error instanceof ApiError && error.code === "hermes_stream_lost" && progressed)
            continue;
          throw error;
        }
      }
    } catch (error) {
      // The run may still go on in Hermes, so it is not known to have failed.
      if (!transient(error))
        return deliverWith({ state: "uncertain", error: (error as Error).message });
      // A 404 on events (Hermes restarted) or a lost stream: read the status now, so `unknown` shows at once.
      try {
        const end = syncRun(row, await hermes.getRun(runId));
        if (end) return deliverWith(end);
      } catch {
        // Hermes is down: wait below.
      }
      return await waitOrFail(row, "follow", reached ? {} : checkpoint, error);
    }
  };

  host.jobs.define<{ handoffId: string }, Checkpoint>(JOB, [
    {
      name: "submit",
      run: ({ subject, checkpoint }) => submit(subject.handoffId, checkpoint ?? {}),
    },
    {
      name: "follow",
      run: ({ subject, checkpoint }) => follow(subject.handoffId, checkpoint ?? {}),
    },
    {
      name: "deliver",
      run: async ({ subject, checkpoint }) => ({
        next: null,
        commit: () => {
          if (checkpoint?.end) finish(subject.handoffId, checkpoint.end);
        },
      }),
    },
  ]);

  /** Writes a new `pending` handoff and its job in one transaction. */
  const create = async (
    owner: { agentId: string; workspaceId: string },
    request: AskHermesRequest,
    receipt: string,
  ): Promise<Row> => {
    const workspace = workspaces.get(owner.workspaceId);
    const project = await projects.get(workspace.projectId);
    const agent = agents.get(owner.agentId);
    const profile = await profileName();
    const id = host.newId();
    const header = `From pi-spore agent ${agent.title ?? agent.id}, project ${project.name}, workspace ${workspace.name}, handoff ${id}.`;
    const what = request.kind === "task" ? "Task" : "Question";
    // Only the text the agent gave, never its transcript.
    const prompt = `${header}\n\n${what}${request.title ? `: ${request.title}` : ""}\n\n${request.text}`;
    const now = host.now();
    store.transaction(() => {
      store.run(
        `INSERT INTO hermes_handoffs (id, direction, agent_id, workspace_id, project_id, profile, kind, title, text,
         prompt, hop_count, state, run_key, idempotency_key, created_at, updated_at)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)`,
        id,
        owner.agentId,
        workspace.id,
        workspace.projectId,
        profile,
        request.kind,
        request.title ?? null,
        request.text,
        prompt,
        id,
        receipt,
        now,
        now,
      );
      update(id, { job_id: host.jobs.start(JOB, { handoffId: id }) });
    });
    return load(id) as Row;
  };

  const own = (caller: BridgeCaller, id: string): Row => {
    const row = load(id);
    if (!row || row.agent_id !== caller.agentId)
      throw new ApiError(404, "handoff_not_found", `No Hermes handoff ${id}`);
    return row;
  };
  const found = (id: string): Row => {
    const row = load(id);
    if (!row) throw new ApiError(404, "handoff_not_found", `No Hermes handoff ${id}`);
    return row;
  };

  const cancel = async (row: Row): Promise<Row> => {
    if (ENDED.has(row.state)) return row;
    update(row.id, { cancel_requested: 1 });
    if (!row.run_id) {
      store.transaction(() => {
        if (row.job_id) host.jobs.cancel(row.job_id);
        finish(row.id, { state: "cancelled" });
      });
      return load(row.id) as Row;
    }
    try {
      // The job follows the run to `cancelled` and delivers then.
      await hermes.stop(row.run_id);
    } catch (error) {
      store.transaction(() => {
        if (row.job_id) host.jobs.cancel(row.job_id);
        finish(row.id, {
          state: "uncertain",
          error: `Hermes did not confirm the stop: ${(error as Error).message}`,
        });
      });
    }
    return load(row.id) as Row;
  };

  // Home items: controls that wait for the user, and uncertain handoffs that wait for a pick (ADR 0155).
  homeItems.register("hermes", async () => {
    const timeout = await timeoutMs();
    const now = host.now();
    const controls = store.all<ControlRow & { title: string | null }>(
      `SELECT c.*, h.title FROM hermes_controls c JOIN hermes_handoffs h ON h.id = c.handoff_id
       WHERE c.state = 'open' AND c.created_at > ? ORDER BY c.created_at`,
      now - timeout,
    );
    const uncertain = store.all<Row>(
      "SELECT * FROM hermes_handoffs WHERE state = 'uncertain' AND resolution IS NULL ORDER BY updated_at",
    );
    return [
      ...controls.map((control) => ({
        id: `control:${control.handoff_id}:${control.prompt_id}`,
        at: control.created_at,
        title:
          control.kind === "approval"
            ? "Hermes asks to run a command"
            : "Hermes asks you a question",
        detail: [
          control.command ?? control.question,
          control.description,
          `Handoff ${control.handoff_id}${control.title ? ` (${control.title})` : ""}`,
          `${Math.max(0, Math.ceil((control.created_at + timeout - now) / 1000))} s left`,
        ]
          .filter(Boolean)
          .join(" · "),
        href: "#/hermes",
      })),
      ...uncertain.map((row) => ({
        id: `uncertain:${row.id}`,
        at: row.updated_at,
        title: "A Hermes handoff needs your decision",
        detail: `Handoff ${row.id}${row.title ? ` (${row.title})` : ""} is uncertain: check what is known, then pick.`,
        href: "#/hermes",
      })),
    ];
  });

  host.routes.get("/handoffs", async (c) => {
    const timeout = await timeoutMs();
    const rows = store.all<Row>(
      "SELECT * FROM hermes_handoffs ORDER BY created_at DESC, id DESC LIMIT 100",
    );
    return c.json({ handoffs: rows.map((row) => view(row, timeout)) });
  });

  host.routes.post("/handoffs/:id/cancel", async (c) =>
    c.json({ handoff: await viewOf(await cancel(found(c.req.param("id")))) }),
  );

  host.routes.get("/handoffs/:id/reconcile", async (c) => {
    const row = found(c.req.param("id"));
    let runStatus: string;
    try {
      runStatus = row.run_id ? (await hermes.getRun(row.run_id)).status : "no run";
    } catch (error) {
      runStatus = `not readable: ${(error as Error).message}`;
    }
    let messages: HermesReconcile["messages"] = [];
    if (row.session_id) {
      const { data } = await hermes.sessionMessages(row.session_id, { order: "latest", limit: 20 });
      messages = data.reverse().map((entry) => ({
        role: entry.role,
        ...(entry.content ? { content: cap(entry.content, FACT_CAP) } : {}),
        ...(entry.tool_name ? { tool: entry.tool_name } : {}),
      }));
    }
    const body: HermesReconcile = {
      handoff: await viewOf(row),
      runStatus,
      ...(row.tool_started ? { toolStarted: row.tool_started } : {}),
      ...(row.tool_finished ? { toolFinished: row.tool_finished } : {}),
      messages,
    };
    return c.json(body);
  });

  host.routes.post("/handoffs/:id/resolve", async (c) => {
    const row = found(c.req.param("id"));
    const request = parseJsonBody(ResolveHermesHandoffRequest, await c.req.text(), "pick");
    if (row.state !== "uncertain" || row.resolution !== null)
      throw new ApiError(409, "handoff_not_uncertain", `Handoff ${row.id} waits for no pick`);
    if (request.action === "interrupt") {
      if (!row.run_id) throw new ApiError(409, "handoff_no_run", `Handoff ${row.id} has no run`);
      // The exact pair from the run status now (spike Q3).
      const run = await hermes.getRun(row.run_id);
      const admission = run.admission_id ?? row.admission_id;
      const generation = run.execution_generation ?? row.execution_generation;
      if (
        admission === null ||
        admission === undefined ||
        generation === null ||
        generation === undefined
      )
        throw new ApiError(
          409,
          "handoff_no_admission",
          `Hermes names no admission for run ${row.run_id}`,
        );
      await hermes.resolveUnknown(row.run_id, {
        admission_id: admission,
        execution_generation: generation,
      });
      update(row.id, { resolution: "interrupted", state: "cancelled" });
    } else if (request.action === "drop") {
      update(row.id, { resolution: "dropped" });
    } else {
      const { changes } = store.run(
        "UPDATE hermes_handoffs SET resolution = 'resent' WHERE id = ? AND resolution IS NULL",
        row.id,
      );
      if (changes === 0)
        throw new ApiError(409, "handoff_not_uncertain", `Handoff ${row.id} waits for no pick`);
      // A new handoff: a new id, so a new session and a new Idempotency-Key. The old session waits on its unknown run.
      try {
        const fresh = await create(
          { agentId: row.agent_id, workspaceId: row.workspace_id },
          { kind: row.kind, text: row.text, ...(row.title ? { title: row.title } : {}) },
          `resend:${row.id}`,
        );
        update(row.id, { resent_as: fresh.id });
      } catch (error) {
        update(row.id, { resolution: null });
        throw error;
      }
    }
    homeItems.changed();
    return c.json({ handoff: await viewOf(load(row.id) as Row) });
  });

  host.routes.post("/handoffs/:id/controls/:promptId", async (c) => {
    const row = found(c.req.param("id"));
    const promptId = c.req.param("promptId");
    const request = parseJsonBody(AnswerHermesControlRequest, await c.req.text(), "answer");
    const timeout = await timeoutMs();
    const expire = () => {
      store.run(
        "UPDATE hermes_controls SET state = 'expired', updated_at = ? WHERE handoff_id = ? AND prompt_id = ?",
        host.now(),
        row.id,
        promptId,
      );
      homeItems.changed();
      return new ApiError(409, "control_expired", "This Hermes request expired; nothing was sent");
    };
    const control = controlsOf(row.id).find((entry) => entry.prompt_id === promptId);
    if (!control) throw new ApiError(404, "control_not_found", `No Hermes request ${promptId}`);
    const isApproval = "choice" in request;
    if (isApproval !== (control.kind === "approval"))
      throw new ApiError(
        400,
        "bad_answer",
        `Answer a ${control.kind} with ${control.kind === "approval" ? "choice" : "answer"}`,
      );
    if (control.state === "open" && host.now() > control.created_at + timeout) throw expire();
    // One answer posts once: only the request that moves the control out of `open` sends it.
    const { changes } = store.run(
      "UPDATE hermes_controls SET state = 'answering', updated_at = ? WHERE handoff_id = ? AND prompt_id = ? AND state = 'open'",
      host.now(),
      row.id,
      promptId,
    );
    if (changes === 0)
      throw new ApiError(
        409,
        "control_expired",
        `This Hermes request is ${control.state}; nothing was sent`,
      );
    try {
      const target = { request_id: promptId, execution_generation: control.execution_generation };
      if (isApproval)
        await hermes.answerApproval(row.run_id as string, { ...target, choice: request.choice });
      else await hermes.answerClarify(row.run_id as string, { ...target, answer: request.answer });
    } catch (error) {
      // Hermes moved on: a stale generation, a request it no longer has, or a run that ended.
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 400 || error.status === 404)
      )
        throw expire();
      store.run(
        "UPDATE hermes_controls SET state = 'open', updated_at = ? WHERE handoff_id = ? AND prompt_id = ?",
        host.now(),
        row.id,
        promptId,
      );
      throw error;
    }
    store.run(
      "UPDATE hermes_controls SET state = 'answered', updated_at = ? WHERE handoff_id = ? AND prompt_id = ?",
      host.now(),
      row.id,
      promptId,
    );
    homeItems.changed();
    return c.json({ handoff: await viewOf(load(row.id) as Row) });
  });

  return {
    async ask(caller, request, receipt) {
      const again = store.get<Row>(
        "SELECT * FROM hermes_handoffs WHERE agent_id = ? AND idempotency_key = ?",
        caller.agentId,
        receipt,
      );
      if (again) return await viewOf(again);
      if (agents.get(caller.agentId).kind === "stage")
        throw new ApiError(
          403,
          "hermes_refused",
          "A pipeline stage cannot ask Hermes; ask your run's asking chat instead",
        );
      // The hop rule (ADR 0202 decision 9): a chat that works on a Hermes request cannot ask Hermes back.
      if (
        store.get(
          `SELECT 1 FROM hermes_handoffs WHERE direction = 'in' AND agent_id = ?
           AND state NOT IN ('completed', 'cancelled', 'failed', 'uncertain')`,
          caller.agentId,
        )
      )
        throw new ApiError(
          403,
          "hermes_refused",
          "This chat works on a request from Hermes, so it cannot ask Hermes (no loops)",
        );
      const status = await hermes.status();
      // Offline is fine: the handoff waits as `pending`. Off or set up wrong is the user's to fix first.
      if (status.state === "disabled")
        throw new ApiError(503, "hermes_not_ready", "Hermes is off; set hermes.enabled to true");
      if (status.state === "unauthorized" || status.state === "incompatible")
        throw new ApiError(503, "hermes_not_ready", `Hermes is ${status.state}: ${status.detail}`);
      return await viewOf(await create(caller, request, receipt));
    },
    async cancel(caller, id) {
      return await viewOf(await cancel(own(caller, id)));
    },
  };
}
