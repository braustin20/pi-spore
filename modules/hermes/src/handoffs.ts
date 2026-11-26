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
  type HermesHandoff,
  type HermesHandoffState,
  parseJsonBody,
  ResolveHermesHandoffRequest,
} from "@pi-spore/shared";
import Type from "typebox";
import type { Hermes, Run, RunEvent } from "./contract.js";
import { type ControlRow, type Controls, runFacts } from "./controls.js";

const JOB = "hermes.ask";
const ENDED: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "uncertain"]);
/** Connector errors that mean Hermes did not answer at all. */
const UNREACHABLE: ReadonlySet<string> = new Set([
  "hermes_unreachable",
  "hermes_timeout",
  "hermes_unavailable",
]);
/** The first wait after Hermes did not answer; it doubles up to `MAX_BACKOFF_MS`. Same as the status poll. */
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;
/** How much of a result goes into the delivered message. The full result stays on the handoff. */
const MESSAGE_CAP = 4_000;
/** How long a sent stop may take to show as an ended run, and how often the cancel step reads the run meanwhile. */
const STOP_CONFIRM_MS = 60_000;
const STOP_POLL_MS = 2_000;
/** Pages of 100 sessions read to find a handoff's session record. */
const SESSION_PAGES = 5;

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
  /** 1 once a `POST /v1/runs` went out: from then on Hermes may have the run, even with no `run_id` stored. */
  run_posted: number;
  stop_sent_at: number | null;
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
    run_posted INTEGER NOT NULL DEFAULT 0,
    stop_sent_at INTEGER,
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
  controls: Controls,
  settings: { profile: () => Promise<string>; enabled: () => Promise<boolean> },
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
  const timeoutMs = controls.timeoutMs;

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
      controls: controls.list(row.id, timeout),
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
    const cancelled = row.cancel_requested === 1;
    if (end.state === "completed") {
      if (cancelled) lines.push("It finished before the cancel took effect.");
    } else if (end.state === "cancelled" && cancelled)
      lines.push("It was cancelled. Steps Hermes completed are not undone.");
    else lines.push("Side effects that already happened in Hermes are not undone.");
    return lines.join("\n");
  };

  /**
   * Stores the end state and delivers the one message in the same transaction (architecture 6). A handoff that
   * already ended, or that another job owns now (`jobId`), is left as it is, so no path delivers twice.
   */
  const finish = (id: string, end: End, jobId?: string): boolean => {
    let ended = false;
    store.transaction(() => {
      const row = load(id);
      if (!row || ENDED.has(row.state) || (jobId !== undefined && row.job_id !== jobId)) return;
      update(id, {
        state: end.state,
        result_text: end.result ?? null,
        error: end.error ?? null,
      });
      controls.expireOpen(id);
      // A chat removed since the ask has nobody to tell; the end is still stored for the page.
      if (asker(row.agent_id)) agents.deliver(row.agent_id, message(row, end));
      else
        host.log.warn("The chat that asked Hermes is gone", { handoff: id, agent: row.agent_id });
      ended = true;
    });
    if (ended) homeItems.changed();
    return ended;
  };

  const asker = (agentId: string) => {
    try {
      return agents.get(agentId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  };

  /** The handoff while job `jobId` owns it and it has not ended. A replaced or cancelled job's late step gets none. */
  const owned = (id: string, jobId: string): Row | undefined => {
    const row = load(id);
    return row && row.job_id === jobId && !ENDED.has(row.state) ? row : undefined;
  };
  const updateOwned = (id: string, jobId: string, fields: Partial<Row>) => {
    if (owned(id, jobId)) update(id, fields);
  };

  /** Stores what the run status says, while `jobId` owns the handoff. Returns the end once the run ended or is `unknown`. */
  const syncRun = (row: Row, run: Run, jobId: string): End | undefined => {
    const state = STATE_OF[run.status];
    if (!owned(row.id, jobId)) return undefined;
    controls.sync(row.id, run, row.execution_generation);
    const fields: Partial<Row> = {
      ...(run.admission_id === undefined ? {} : { admission_id: run.admission_id }),
      ...(run.execution_generation === undefined
        ? {}
        : { execution_generation: run.execution_generation }),
    };
    if (!ENDED.has(state)) fields.state = state;
    const runtime = run.runtime;
    if (runtime?.provider) fields.provider = runtime.provider;
    if (runtime?.model) fields.model = runtime.model;
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
  const offlineMs = async () => (await host.settings.resolve()).get(offlineHours).value * 3_600_000;
  /** Past the wait, a resend may outlive Hermes's 24 h key retention, so a run that may exist is not sent again. */
  const expired = (row: Row, hours: number): End => ({
    state: row.run_posted ? "uncertain" : "failed",
    error: row.run_posted
      ? `Hermes could not be reached for ${hours} h after a send that may have reached it; pi-spore did not send it again`
      : `Hermes could not be reached for ${hours} h`,
  });

  /**
   * Waits while Hermes cannot be reached, up to `hermes.offlineWaitHours`: from the ask for a handoff not sent yet,
   * from the first failed try for a run being followed.
   */
  const waitOrFail = async (
    row: Row,
    jobId: string,
    step: "submit" | "follow",
    { tries = 0, since }: Checkpoint,
    error: ApiError,
  ): Promise<StepOutcome<Checkpoint>> => {
    const wait = await offlineMs();
    const start = since ?? (step === "submit" ? row.created_at : host.now());
    if (host.now() - start >= wait) {
      const end = expired(row, wait / 3_600_000);
      return deliverWith(step === "follow" ? { ...end, state: "uncertain" } : end);
    }
    // Off, a refused key, or an untested version needs the user, so it does not say offline.
    const offline = UNREACHABLE.has(error.code) || (await hermes.status()).state === "unreachable";
    const why = offline
      ? `Hermes is offline: ${error.message}`
      : `Waiting for Hermes: ${error.message}`;
    return {
      next: step,
      after: backoff(tries),
      checkpoint: { tries: tries + 1, since: start },
      commit: () => updateOwned(row.id, jobId, { error: why }),
    };
  };
  /** Errors that mean "try again later": Hermes is off, down, slow, or answered with a server error. */
  const transient = (error: unknown): error is ApiError =>
    error instanceof ApiError && (error.status >= 500 || error.code === "hermes_run_not_found");

  /** The session record's provider and model, when Hermes has them; blank stays unknown (ADR 0202 decision 7). */
  const refreshSession = async (id: string, jobId: string, sessionId: string) => {
    try {
      for (let page = 0; page < SESSION_PAGES; page += 1) {
        const list = await hermes.listSessions({
          source: "api_server",
          limit: 100,
          offset: page * 100,
        });
        const session = list.data.find((entry) => entry.id === sessionId);
        if (session) {
          const fields: Partial<Row> = {};
          if (session.billing_provider) fields.provider = session.billing_provider;
          if (session.model) fields.model = session.model;
          updateOwned(id, jobId, fields.provider || fields.model ? fields : {});
          return;
        }
        if (!list.has_more) return;
      }
    } catch (error) {
      // Only the shown provider and model depend on it.
      host.log.warn("Could not read the Hermes session record", { error: String(error) });
    }
  };

  /** The identical body and key on every try, so Hermes starts the run at most once (spike Q2). */
  const startRun = (row: Row) =>
    hermes.startRun({ input: row.prompt, session_id: `pi-spore-${row.id}` }, row.run_key);

  const submit = async (
    id: string,
    jobId: string,
    checkpoint: Checkpoint,
  ): Promise<StepOutcome<Checkpoint>> => {
    const row = owned(id, jobId);
    if (!row) return { next: null };
    if (row.cancel_requested) return { next: "cancel", checkpoint: {} };
    if (row.run_id) return { next: "follow", checkpoint: {} };
    const wait = await offlineMs();
    // Checked before every send, so a job that slept past the wait (or a stopped pi-spore) does not send late.
    if (host.now() - row.created_at >= wait) return deliverWith(expired(row, wait / 3_600_000));
    try {
      const name = `pi-spore-${row.id}`;
      if (!row.session_id) {
        try {
          await hermes.createSession({ id: name, title: row.title ?? name });
        } catch (error) {
          // An earlier try made it and lost the answer. It is ours: no other client names sessions this way.
          if (!(error instanceof ApiError && error.code === "hermes_session_exists")) throw error;
        }
        updateOwned(id, jobId, { session_id: name });
        await refreshSession(id, jobId, name);
      }
      // A cancel while the session was made: it wins. From the next line on, a cancel stops the run instead.
      const now = owned(id, jobId);
      if (!now) return { next: null };
      if (now.cancel_requested) return { next: "cancel", checkpoint: {} };
      update(id, { run_posted: 1 });
      const admission = await startRun(row);
      return {
        next: "follow",
        checkpoint: {},
        commit: () =>
          updateOwned(id, jobId, { run_id: admission.run_id, state: "accepted", error: null }),
      };
    } catch (error) {
      if (transient(error)) return await waitOrFail(row, jobId, "submit", checkpoint, error);
      return deliverWith({ state: "failed", error: (error as Error).message });
    }
  };

  /** Handles one event. Returns the end once the run ended. */
  const onEvent = async (row: Row, jobId: string, event: RunEvent): Promise<End | undefined> => {
    switch (event.event) {
      case "tool.started":
        updateOwned(row.id, jobId, {
          tool_started: event.preview ? `${event.tool}: ${event.preview}` : event.tool,
          state: "running",
        });
        return undefined;
      case "tool.completed":
      case "tool.failed": {
        const failed = event.event === "tool.failed" || event.error === true;
        updateOwned(row.id, jobId, {
          tool_finished: `${event.tool ?? row.tool_started ?? "a tool"}${failed ? " (error)" : ""}`,
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
        return syncRun(row, await hermes.getRun(row.run_id as string), jobId);
      default:
        if (row.state === "accepted") updateOwned(row.id, jobId, { state: "running" });
        return undefined;
    }
  };

  /** The end to deliver, after a last read of the session record for the provider and model. */
  const ended = async (row: Row, jobId: string, end: End) => {
    if (row.session_id) await refreshSession(row.id, jobId, row.session_id);
    return deliverWith(end);
  };

  const follow = async (
    id: string,
    jobId: string,
    checkpoint: Checkpoint,
  ): Promise<StepOutcome<Checkpoint>> => {
    const row = owned(id, jobId);
    if (!row?.run_id) return { next: null };
    const runId = row.run_id;
    // Frames came in on this try, so the waits before it no longer count.
    let reached = false;
    try {
      // The status first: after a restart, a lost stream, or a 404 on events, it is the truth (spike Q4).
      const first = syncRun(row, await hermes.getRun(runId), jobId);
      if (first) return await ended(row, jobId, first);
      let last = row.last_event_id ?? undefined;
      while (true) {
        let progressed = false;
        try {
          for await (const frame of hermes.runEvents(runId, last)) {
            // A cancel hands the handoff to a new job; this one stops reading and writes nothing more.
            const live = owned(id, jobId);
            if (!live) return { next: null };
            progressed = true;
            reached = true;
            if (frame.id !== undefined) {
              last = frame.id;
              update(id, { last_event_id: last });
            }
            const end = await onEvent(live, jobId, frame.event);
            if (end) return await ended(live, jobId, end);
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
        const end = syncRun(row, await hermes.getRun(runId), jobId);
        if (end) return await ended(row, jobId, end);
      } catch {
        // Hermes is down: wait below.
      }
      return await waitOrFail(row, jobId, "follow", reached ? {} : checkpoint, error);
    }
  };

  /**
   * Stops the run of a cancelled handoff and waits, at most `STOP_CONFIRM_MS`, for Hermes to show it ended. A send
   * that may have reached Hermes but left no run id is asked again with the identical body and key, which returns
   * that run (or, if the first never got in, starts it once, to be stopped at once). A stop that Hermes refuses or
   * does not confirm ends `uncertain`; a run that ended anyway keeps its own end.
   */
  const cancelStep = async (id: string, jobId: string): Promise<StepOutcome<Checkpoint>> => {
    const row = owned(id, jobId);
    if (!row) return { next: null };
    if (!row.run_posted) return deliverWith({ state: "cancelled" });
    const unconfirmed = (why: string): End => ({
      state: "uncertain",
      error: `Hermes did not confirm the stop: ${why}`,
    });
    try {
      let runId = row.run_id;
      if (!runId) {
        // Past the wait, Hermes may have dropped the key, and the same body would start the task again.
        const wait = await offlineMs();
        if (host.now() - row.created_at >= wait) return deliverWith(expired(row, wait / 3_600_000));
        runId = (await startRun(row)).run_id;
        updateOwned(id, jobId, { run_id: runId });
      }
      let stopSentAt = row.stop_sent_at;
      if (stopSentAt === null) {
        try {
          await hermes.stop(runId);
        } catch (error) {
          // An ended run may refuse the stop: read it before calling the stop unconfirmed.
          const end = syncRun(row, await hermes.getRun(runId), jobId);
          return end
            ? await ended(row, jobId, end)
            : deliverWith(unconfirmed((error as Error).message));
        }
        stopSentAt = host.now();
        updateOwned(id, jobId, { stop_sent_at: stopSentAt });
      }
      const end = syncRun(row, await hermes.getRun(runId), jobId);
      if (end) return await ended(row, jobId, end);
      if (host.now() - stopSentAt >= STOP_CONFIRM_MS)
        return deliverWith(unconfirmed(`the run did not end in ${STOP_CONFIRM_MS / 1000} s`));
      return { next: "cancel", after: STOP_POLL_MS, checkpoint: {} };
    } catch (error) {
      return deliverWith(unconfirmed((error as Error).message));
    }
  };

  host.jobs.define<{ handoffId: string }, Checkpoint>(JOB, [
    {
      name: "submit",
      run: ({ id, subject, checkpoint }) => submit(subject.handoffId, id, checkpoint ?? {}),
    },
    {
      name: "follow",
      run: ({ id, subject, checkpoint }) => follow(subject.handoffId, id, checkpoint ?? {}),
    },
    { name: "cancel", run: ({ id, subject }) => cancelStep(subject.handoffId, id) },
    {
      name: "deliver",
      run: async ({ id, subject, checkpoint }) => ({
        next: null,
        commit: () => {
          if (checkpoint?.end) finish(subject.handoffId, checkpoint.end, id);
        },
      }),
    },
  ]);

  const byReceipt = (agentId: string, receipt: string) =>
    store.get<Row>(
      "SELECT * FROM hermes_handoffs WHERE agent_id = ? AND idempotency_key = ?",
      agentId,
      receipt,
    );

  /**
   * Writes a new `pending` handoff and its job in one transaction, or returns the one this receipt already made. The
   * receipt is read again inside the transaction, after the awaits, so two requests that race get one handoff.
   */
  const create = async (
    owner: { agentId: string; workspaceId: string },
    request: AskHermesRequest,
    receipt: string,
  ): Promise<Row> => {
    const workspace = workspaces.get(owner.workspaceId);
    const project = await projects.get(workspace.projectId);
    const agent = agents.get(owner.agentId);
    const profile = await settings.profile();
    const id = host.newId();
    const header = `From pi-spore agent ${agent.title ?? agent.id}, project ${project.name}, workspace ${workspace.name}, handoff ${id}.`;
    const what = request.kind === "task" ? "Task" : "Question";
    // Only the text the agent gave, never its transcript.
    const prompt = `${header}\n\n${what}${request.title ? `: ${request.title}` : ""}\n\n${request.text}`;
    const now = host.now();
    return store.transaction(() => {
      const again = byReceipt(owner.agentId, receipt);
      if (again) return again;
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
      return load(id) as Row;
    });
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

  /**
   * Cancels a handoff. With nothing sent to Hermes yet it ends `cancelled` at once: the submit step reads
   * `cancel_requested` right before it sends, with no await between, so it cannot send after this. Otherwise a new
   * job runs the cancel step now, even if the old one sleeps in a backoff; the old job writes nothing more.
   */
  const cancel = (row: Row): Row =>
    store.transaction(() => {
      const current = load(row.id) as Row;
      if (ENDED.has(current.state) || current.cancel_requested) return current;
      update(row.id, { cancel_requested: 1 });
      if (current.job_id) host.jobs.cancel(current.job_id);
      if (current.run_posted)
        update(row.id, { job_id: host.jobs.start(JOB, { handoffId: row.id }) });
      else finish(row.id, { state: "cancelled" });
      return load(row.id) as Row;
    });

  // Home items: controls that wait for the user, and uncertain handoffs that wait for a pick (ADR 0155).
  homeItems.register("hermes", async () => {
    // Off means no Home item (ADR 0202 decision 12), even for rows from before.
    if (!(await settings.enabled())) return [];
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

  // Off, the page shows only that Hermes is off, so the list is empty and says so.
  host.routes.get("/handoffs", async (c) => {
    if (!(await settings.enabled())) return c.json({ enabled: false, handoffs: [] });
    const timeout = await timeoutMs();
    const workspaceId = c.req.query("workspaceId");
    const rows = store.all<Row>(
      `SELECT * FROM hermes_handoffs ${workspaceId === undefined ? "" : "WHERE workspace_id = ?"}
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      ...(workspaceId === undefined ? [] : [workspaceId]),
    );
    return c.json({ enabled: true, handoffs: rows.map((row) => view(row, timeout)) });
  });

  host.routes.post("/handoffs/:id/cancel", async (c) =>
    c.json({ handoff: await viewOf(cancel(found(c.req.param("id")))) }),
  );

  host.routes.get("/handoffs/:id/reconcile", async (c) => {
    const row = found(c.req.param("id"));
    return c.json({ handoff: await viewOf(row), ...(await runFacts(hermes, row)) });
  });

  host.routes.post("/handoffs/:id/resolve", async (c) => {
    const row = found(c.req.param("id"));
    const request = parseJsonBody(ResolveHermesHandoffRequest, await c.req.text(), "pick");
    // One pick only: the request that claims the row acts, so a double click sends nothing twice.
    const claim = (resolution: NonNullable<Row["resolution"]>) => {
      const { changes } = store.run(
        "UPDATE hermes_handoffs SET resolution = ?, updated_at = ? WHERE id = ? AND state = 'uncertain' AND resolution IS NULL",
        resolution,
        host.now(),
        row.id,
      );
      if (changes === 0)
        throw new ApiError(409, "handoff_not_uncertain", `Handoff ${row.id} waits for no pick`);
    };
    const unclaim = () => update(row.id, { resolution: null });
    if (request.action === "drop") claim("dropped");
    else if (request.action === "interrupt") {
      if (!row.run_id) throw new ApiError(409, "handoff_no_run", `Handoff ${row.id} has no run`);
      claim("interrupted");
      try {
        // The exact pair from the run status now (spike Q3).
        const run = await hermes.getRun(row.run_id);
        const admission = run.admission_id ?? row.admission_id;
        const generation = run.execution_generation ?? row.execution_generation;
        if (admission == null || generation == null)
          throw new ApiError(
            409,
            "handoff_no_admission",
            `Hermes names no admission for run ${row.run_id}`,
          );
        await hermes.resolveUnknown(row.run_id, {
          admission_id: admission,
          execution_generation: generation,
        });
      } catch (error) {
        unclaim();
        throw error;
      }
      update(row.id, { state: "cancelled" });
    } else {
      claim("resent");
      // A new handoff: a new id, so a new session and a new Idempotency-Key. The old session waits on its unknown run.
      try {
        const fresh = await create(
          { agentId: row.agent_id, workspaceId: row.workspace_id },
          { kind: row.kind, text: row.text, ...(row.title ? { title: row.title } : {}) },
          `resend:${row.id}`,
        );
        update(row.id, { resent_as: fresh.id });
      } catch (error) {
        unclaim();
        throw error;
      }
    }
    homeItems.changed();
    return c.json({ handoff: await viewOf(load(row.id) as Row) });
  });

  host.routes.post("/handoffs/:id/controls/:promptId", async (c) => {
    const row = found(c.req.param("id"));
    const request = parseJsonBody(AnswerHermesControlRequest, await c.req.text(), "answer");
    await controls.answer(row.id, row.run_id as string, c.req.param("promptId"), request);
    return c.json({ handoff: await viewOf(load(row.id) as Row) });
  });

  return {
    async ask(caller, request, receipt) {
      const again = byReceipt(caller.agentId, receipt);
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
      return await viewOf(cancel(own(caller, id)));
    },
  };
}
