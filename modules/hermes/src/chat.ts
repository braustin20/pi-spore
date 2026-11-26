import { HomeItemsKey } from "@pi-spore/mod-attention/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { ApiError, type JobTimer, type ServerHost } from "@pi-spore/module-api";
import {
  AnswerHermesControlRequest,
  CreateHermesChatSessionRequest,
  type HermesChatEvent,
  type HermesChatRun,
  type HermesChatSession,
  type HermesChatSessionList,
  type HermesChatTool,
  parseJsonBody,
  ResolveHermesChatRunRequest,
  SendHermesChatRequest,
} from "@pi-spore/shared";
import type { Hermes, Run, RunEvent, Session } from "./contract.js";
import { type Controls, runFacts } from "./controls.js";

/** Topic of a session's live events. The browser subscribes; it never talks to Hermes. */
export const SESSION_TOPIC = "hermes:session:";
/** States after which pi-spore stops following. `unknown` waits for the user's pick (ADR 0202 decision 6). */
const ENDED: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
  "unknown",
]);
/** Errors on a run post that mean this try sent nothing. Any other 5xx may have reached Hermes. */
const NOT_SENT: ReadonlySet<string> = new Set(["hermes_not_ready", "hermes_key_file"]);
/** How long Hermes keeps an Idempotency-Key (spike Q2). A later retry could start a second run. */
const KEY_RETENTION_MS = 24 * 3_600_000;
/**
 * The wait before following a run again after the stream was lost with no new frame, or Hermes did not answer. It
 * doubles to `RETRY_MAX_MS`. These differ from the status poll's waits, so tests can fire one without the other.
 */
export const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 32_000;
/** Pages of 100 sessions read for the list, and to find one session's record. */
const SESSION_PAGES = 5;
/** Runs a session's snapshot holds. */
const SNAPSHOT_RUNS = 20;

interface SessionRow {
  id: string;
  title: string;
  project_id: string | null;
  created_at: number;
}

interface RunRow {
  id: string;
  session_id: string;
  input: string;
  run_key: string;
  run_id: string | null;
  state: HermesChatRun["state"];
  admission_id: string | null;
  execution_generation: number | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  /** 1 once a post may have reached Hermes, so the run may exist even with no `run_id`. */
  run_posted: number;
  stop_requested: number;
  resolution: "interrupted" | null;
  tool_started: string | null;
  tool_finished: string | null;
  created_at: number;
  updated_at: number;
}

/** What the stream showed in this process. A restarted pi-spore follows from the first frame, so it fills again. */
interface Live {
  text: string;
  /** Deltas in `text`. */
  seq: number;
  tools: HermesChatTool[];
  last: string | undefined;
  reconnecting: string | undefined;
}

export const CHAT_MIGRATIONS = [
  `CREATE TABLE hermes_chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE hermes_chat_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    input TEXT NOT NULL,
    run_key TEXT NOT NULL,
    run_id TEXT,
    state TEXT NOT NULL,
    admission_id TEXT,
    execution_generation INTEGER,
    provider TEXT,
    model TEXT,
    error TEXT,
    run_posted INTEGER NOT NULL DEFAULT 0,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    tool_started TEXT,
    tool_finished TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX hermes_chat_runs_session ON hermes_chat_runs (session_id, created_at);`,
];

const integer = (raw: string | undefined, name: string, min: number, max: number) => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new ApiError(400, "bad_query", `${name} must be a whole number from ${min} to ${max}`);
  return value;
};

/**
 * The Hermes chat page's server side (ADR 0202, card Hermes 2.1): pi-spore-owned API sessions on the profile, runs
 * started from the page, and a relay of each run's events to topic `hermes:session:<id>`. pi-spore sends only into
 * sessions it made here (decision 11). Approvals and clarify go through `controls`, the handoffs' answer path. Nothing
 * here answers a control, resolves a run, or sends a run again on its own.
 */
export function setupChat(
  host: ServerHost,
  hermes: Hermes,
  controls: Controls,
  options: { enabled: () => Promise<boolean>; timer: JobTimer },
) {
  const { store } = host;
  const homeItems = host.use(HomeItemsKey);
  const projects = host.use(ProjectsKey);
  store.migrate("hermes-chat", CHAT_MIGRATIONS);

  const live = new Map<string, Live>();
  const liveOf = (id: string) => {
    let entry = live.get(id);
    if (!entry) {
      entry = { text: "", seq: 0, tools: [], last: undefined, reconnecting: undefined };
      live.set(id, entry);
    }
    return entry;
  };

  const load = (id: string) => store.get<RunRow>("SELECT * FROM hermes_chat_runs WHERE id = ?", id);
  const found = (id: string) => {
    const row = load(id);
    if (!row) throw new ApiError(404, "hermes_chat_run_not_found", `No Hermes chat run ${id}`);
    return row;
  };
  const update = (id: string, fields: Partial<RunRow>) => {
    const names = Object.keys(fields);
    if (names.length === 0) return;
    store.run(
      `UPDATE hermes_chat_runs SET ${names.map((name) => `${name} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ...names.map((name) => fields[name as keyof RunRow] as string | number | null),
      host.now(),
      id,
    );
  };

  const view = (row: RunRow, timeout: number): HermesChatRun => {
    const entry = live.get(row.id);
    const optional = {
      runId: row.run_id,
      provider: row.provider,
      model: row.model,
      error: row.error,
      resolution: row.resolution,
      reconnecting: ENDED.has(row.state) ? undefined : entry?.reconnecting,
    };
    return {
      id: row.id,
      sessionId: row.session_id,
      input: row.input,
      state: row.state,
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value != null)),
      stopRequested: row.stop_requested === 1,
      text: entry?.text ?? "",
      textSeq: entry?.seq ?? 0,
      tools: entry?.tools ?? [],
      controls: controls.list(row.id, timeout),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  const viewOf = async (id: string) => {
    const timeout = await controls.timeoutMs();
    return view(found(id), timeout);
  };
  const publish = (sessionId: string, event: HermesChatEvent) =>
    host.events.publish(`${SESSION_TOPIC}${sessionId}`, event);
  /** The view is built after the await, so a delta published meanwhile is in it, not after it. */
  const publishRun = async (id: string) => {
    const run = await viewOf(id);
    publish(run.sessionId, { type: "run", run });
    return run;
  };

  const handoffSessions = () =>
    new Set(
      store
        .all<{ session_id: string }>(
          "SELECT session_id FROM hermes_handoffs WHERE session_id IS NOT NULL",
        )
        .map((row) => row.session_id),
    );
  const sessionView = (
    session: Session,
    row: SessionRow | undefined,
    handoffs: ReadonlySet<string>,
  ): HermesChatSession => {
    const api = session.source === "api_server";
    const kind = api && row ? "chat" : api && handoffs.has(session.id) ? "handoff" : "foreign";
    const readOnly =
      kind === "chat"
        ? undefined
        : kind === "handoff"
          ? "A handoff session; read-only here"
          : api
            ? "Not made by pi-spore's chat page"
            : `Owned by ${session.source}`;
    const title = row?.title ?? session.title;
    return {
      id: session.id,
      source: session.source,
      kind,
      ...(title ? { title } : {}),
      ...(readOnly ? { readOnly } : {}),
      ...(row?.project_id ? { projectId: row.project_id } : {}),
      ...(session.billing_provider ? { provider: session.billing_provider } : {}),
      ...(session.model ? { model: session.model } : {}),
    };
  };

  /** The session record's provider and model, when Hermes has them; blank stays unknown (ADR 0202 decision 7). */
  const sessionMeta = async (sessionId: string): Promise<Partial<RunRow>> => {
    try {
      for (let page = 0; page < SESSION_PAGES; page += 1) {
        const list = await hermes.listSessions({
          source: "api_server",
          limit: 100,
          offset: page * 100,
        });
        const session = list.data.find((entry) => entry.id === sessionId);
        if (session)
          return {
            ...(session.billing_provider ? { provider: session.billing_provider } : {}),
            ...(session.model ? { model: session.model } : {}),
          };
        if (!list.has_more) return {};
      }
    } catch (error) {
      // Only the shown provider and model depend on it.
      host.log.warn("Could not read the Hermes session record", { error: String(error) });
    }
    return {};
  };

  /** Stores what the run status says. Returns true once pi-spore stops following: the run ended or is `unknown`. */
  const applyRun = async (id: string, run: Run): Promise<boolean> => {
    const row = load(id);
    if (!row || ENDED.has(row.state)) return true;
    controls.sync(id, run, row.execution_generation);
    const fields: Partial<RunRow> = { state: run.status };
    if (run.admission_id !== undefined) fields.admission_id = run.admission_id;
    if (run.execution_generation !== undefined)
      fields.execution_generation = run.execution_generation;
    if (run.runtime?.provider) fields.provider = run.runtime.provider;
    if (run.runtime?.model) fields.model = run.runtime.model;
    const ended = ENDED.has(run.status);
    if (ended && run.status !== "unknown") Object.assign(fields, await sessionMeta(row.session_id));
    if (run.status === "failed") fields.error = "Hermes says the run failed.";
    if (run.status === "unknown")
      fields.error =
        "Hermes restarted during the run; whether its last step finished is not known. Check what is known, then pick.";
    // A stop or a pick may have ended the row during the await; its end stays.
    if (ENDED.has(load(id)?.state ?? "completed")) return true;
    update(id, fields);
    if (run.status === "unknown") homeItems.changed();
    await publishRun(id);
    // A completed run's text and tools are in the stored transcript now, so the server keeps no copy.
    if (run.status === "completed") live.delete(id);
    return ended;
  };

  const setReconnecting = async (id: string, why: string | undefined) => {
    const entry = liveOf(id);
    if (entry.reconnecting === why) return;
    entry.reconnecting = why;
    await publishRun(id);
  };

  /** Handles one event. Returns true once pi-spore stops following. */
  const onEvent = async (row: RunRow, event: RunEvent): Promise<boolean> => {
    const entry = liveOf(row.id);
    switch (event.event) {
      case "message.delta":
        entry.text += event.delta;
        entry.seq += 1;
        publish(row.session_id, {
          type: "delta",
          runId: row.id,
          delta: event.delta,
          seq: entry.seq,
        });
        return false;
      case "tool.started":
        entry.tools.push({
          name: event.tool,
          ...(event.preview ? { preview: event.preview } : {}),
          state: "running",
        });
        update(row.id, {
          tool_started: event.preview ? `${event.tool}: ${event.preview}` : event.tool,
        });
        await publishRun(row.id);
        return false;
      case "tool.completed":
      case "tool.failed": {
        const failed = event.event === "tool.failed" || event.error === true;
        const tool =
          entry.tools.findLast((t) => t.state === "running" && t.name === event.tool) ??
          entry.tools.findLast((t) => t.state === "running");
        if (tool) tool.state = failed ? "failed" : "done";
        update(row.id, {
          tool_finished: `${event.tool ?? tool?.name ?? "a tool"}${failed ? " (error)" : ""}`,
        });
        await publishRun(row.id);
        return false;
      }
      case "approval.request":
      case "approval.responded":
      case "clarify.request":
      case "run.completed":
      case "run.cancelled":
      case "run.failed":
      case "run.interrupted":
      case "replay.truncated":
        return await applyRun(row.id, await hermes.getRun(row.run_id as string));
      default:
        if (row.state === "queued") {
          update(row.id, { state: "running" });
          await publishRun(row.id);
        }
        return false;
    }
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      options.timer(async () => resolve(), ms);
    });

  const following = new Set<string>();
  /**
   * Follows a run until it ends or is `unknown`: the status first, then the SSE stream from the last frame seen in
   * this process. A drop after new frames resumes at once; a drop without, or Hermes down or off, waits
   * `RETRY_FIRST_MS`, doubling. Off, it only reads settings until Hermes is on again. It never posts a run.
   */
  const follow = (id: string) => {
    if (following.has(id)) return;
    following.add(id);
    void (async () => {
      let failures = 0;
      while (true) {
        const row = load(id);
        if (!row?.run_id || ENDED.has(row.state)) return;
        const entry = liveOf(id);
        let progressed = false;
        try {
          // Off sends nothing: wait, and look again.
          if (!(await options.enabled()))
            throw new ApiError(
              503,
              "hermes_not_ready",
              "Hermes is off; set hermes.enabled to true",
            );
          if (await applyRun(id, await hermes.getRun(row.run_id))) return;
          await setReconnecting(id, undefined);
          for await (const frame of hermes.runEvents(row.run_id, entry.last)) {
            progressed = true;
            failures = 0;
            if (frame.id !== undefined) entry.last = frame.id;
            const now = load(id);
            if (!now || ENDED.has(now.state)) return;
            if (await onEvent(now, frame.event)) return;
          }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await setReconnecting(id, `Reconnecting: ${error.message}`);
          if (error.code === "hermes_stream_lost" && progressed) continue;
          // A 404 on events (Hermes restarted) or a lost stream: read the status now, so `unknown` shows at once.
          try {
            if (await applyRun(id, await hermes.getRun(row.run_id))) return;
          } catch {
            // Hermes is down: wait below.
          }
        }
        // A terminal frame whose status read did not end the run, or a failure: read again after a wait.
        await wait(Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** failures));
        failures += 1;
      }
    })()
      .catch((error: unknown) =>
        host.log.error("Following a Hermes chat run failed", { run: id, error: String(error) }),
      )
      .finally(() => following.delete(id));
  };
  const followable = (row: RunRow) =>
    row.run_id !== null && !ENDED.has(row.state) && row.state !== "sending";

  /** Posts the run. The same key and body on every try, so Hermes starts it at most once (spike Q2). */
  const post = async (id: string): Promise<HermesChatRun> => {
    const row = found(id);
    try {
      const admission = await hermes.startRun(
        { input: row.input, session_id: row.session_id },
        row.run_key,
      );
      update(id, { run_id: admission.run_id, state: "queued", error: null });
      follow(id);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // A refusal: Hermes did not admit it, or it would have replayed the first run. A check before sending: this try
      // sent nothing, but an earlier try may have. A 5xx or no answer: it may have reached Hermes.
      if (error.status < 500 || (NOT_SENT.has(error.code) && row.run_posted === 0))
        update(id, { state: "failed", error: error.message });
      else if (NOT_SENT.has(error.code))
        update(id, {
          error: `Nothing was sent now (${error.message}). An earlier try may have reached Hermes; Retry when Hermes is ready.`,
        });
      else
        update(id, {
          run_posted: 1,
          error: `Hermes did not answer, so the message may have reached it. Retry sends the same message with the same key. (${error.message})`,
        });
    }
    return await publishRun(id);
  };

  host.events.onSubscribe(SESSION_TOPIC, async (topic) => {
    const sessionId = topic.slice(SESSION_TOPIC.length);
    const timeout = await controls.timeoutMs();
    const rows = store
      .all<RunRow>(
        "SELECT * FROM hermes_chat_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        sessionId,
        SNAPSHOT_RUNS,
      )
      .reverse();
    // Opening the session follows its runs again, such as after Hermes was off.
    if (rows.some(followable) && (await options.enabled()))
      for (const row of rows) if (followable(row)) follow(row.id);
    const event: HermesChatEvent = {
      type: "snapshot",
      runs: rows.map((row) => view(row, timeout)),
    };
    return [event];
  });

  host.onStarted(async () => {
    if (!(await options.enabled())) return;
    for (const row of store.all<RunRow>(
      "SELECT * FROM hermes_chat_runs WHERE run_id IS NOT NULL ORDER BY created_at",
    ))
      if (followable(row)) follow(row.id);
  });

  // Home items: open controls of chat runs, and runs left `unknown` that wait for a pick (ADR 0155).
  homeItems.register("hermes-chat", async () => {
    // Off means no Home item (ADR 0202 decision 12).
    if (!(await options.enabled())) return [];
    const timeout = await controls.timeoutMs();
    const now = host.now();
    const open = store.all<{
      handoff_id: string;
      prompt_id: string;
      kind: string;
      command: string | null;
      question: string | null;
      description: string | null;
      created_at: number;
      session_id: string;
    }>(
      `SELECT c.*, r.session_id FROM hermes_controls c JOIN hermes_chat_runs r ON r.id = c.handoff_id
       WHERE c.state = 'open' AND c.created_at > ? ORDER BY c.created_at`,
      now - timeout,
    );
    const unknown = store.all<RunRow>(
      "SELECT * FROM hermes_chat_runs WHERE state = 'unknown' AND resolution IS NULL ORDER BY updated_at",
    );
    const href = (sessionId: string) => `#/hermes/${encodeURIComponent(sessionId)}`;
    return [
      ...open.map((control) => ({
        id: `chat-control:${control.handoff_id}:${control.prompt_id}`,
        at: control.created_at,
        title:
          control.kind === "approval"
            ? "Hermes asks to run a command"
            : "Hermes asks you a question",
        detail: [
          control.command ?? control.question,
          control.description,
          `Hermes chat ${control.session_id}`,
          `${Math.max(0, Math.ceil((control.created_at + timeout - now) / 1000))} s left`,
        ]
          .filter(Boolean)
          .join(" · "),
        href: href(control.session_id),
      })),
      ...unknown.map((row) => ({
        id: `chat-unknown:${row.id}`,
        at: row.updated_at,
        title: "A Hermes chat run needs your decision",
        detail: `Hermes lost track of a run in chat ${row.session_id}: check what is known, then pick.`,
        href: href(row.session_id),
      })),
    ];
  });

  host.routes.get("/chat/sessions", async (c) => {
    // Off: no request to Hermes at all.
    if (!(await options.enabled()))
      return c.json({ enabled: false, sessions: [] } satisfies HermesChatSessionList);
    const all: Session[] = [];
    for (let page = 0; page < SESSION_PAGES; page += 1) {
      const list = await hermes.listSessions({ limit: 100, offset: page * 100 });
      all.push(...list.data);
      if (!list.has_more) break;
    }
    const ours = new Map(
      store.all<SessionRow>("SELECT * FROM hermes_chat_sessions").map((row) => [row.id, row]),
    );
    const handoffs = handoffSessions();
    const body: HermesChatSessionList = {
      enabled: true,
      sessions: all.map((session) => sessionView(session, ours.get(session.id), handoffs)),
    };
    return c.json(body);
  });

  host.routes.post("/chat/sessions", async (c) => {
    const request = parseJsonBody(CreateHermesChatSessionRequest, await c.req.text(), "session");
    if (request.projectId !== undefined) await projects.get(request.projectId);
    const id = `pi-spore-chat-${host.newId()}`;
    const session = await hermes.createSession({ id, title: request.title });
    const row: SessionRow = {
      id,
      title: request.title,
      project_id: request.projectId ?? null,
      created_at: host.now(),
    };
    store.run(
      "INSERT INTO hermes_chat_sessions (id, title, project_id, created_at) VALUES (?, ?, ?, ?)",
      row.id,
      row.title,
      row.project_id,
      row.created_at,
    );
    return c.json({ session: sessionView(session, row, new Set()) }, 201);
  });

  // Any session of the profile can be read (decision 11); only the page's own take a run.
  host.routes.get("/chat/sessions/:id/messages", async (c) => {
    const order = c.req.query("order") as "oldest" | "latest" | undefined;
    if (order !== undefined && order !== "oldest" && order !== "latest")
      throw new ApiError(400, "bad_query", "order must be oldest or latest");
    const query = {
      ...(order === undefined ? {} : { order }),
      limit: integer(c.req.query("limit"), "limit", 1, 200) ?? 100,
      offset: integer(c.req.query("offset"), "offset", 0, 1_000_000) ?? 0,
    };
    const { data } = await hermes.sessionMessages(c.req.param("id"), query);
    return c.json({
      messages: data.map((entry) => ({
        id: entry.id,
        role: entry.role,
        ...(entry.content ? { content: entry.content } : {}),
        ...(entry.tool_name ? { tool: entry.tool_name } : {}),
      })),
    });
  });

  host.routes.post("/chat/sessions/:id/runs", async (c) => {
    const sessionId = c.req.param("id");
    const request = parseJsonBody(SendHermesChatRequest, await c.req.text(), "message");
    if (!store.get("SELECT 1 FROM hermes_chat_sessions WHERE id = ?", sessionId))
      throw new ApiError(
        403,
        "hermes_session_read_only",
        `pi-spore sends only into sessions its Hermes chat page made; ${sessionId} is read-only here`,
      );
    const id = host.newId();
    store.transaction(() => {
      // Hermes runs one run of a session at a time, and a run left `unknown` blocks the session until it is resolved.
      const busy = store.get<{ id: string }>(
        `SELECT id FROM hermes_chat_runs WHERE session_id = ?
         AND state NOT IN ('completed', 'cancelled', 'failed', 'interrupted')`,
        sessionId,
      );
      if (busy)
        throw new ApiError(
          409,
          "hermes_run_active",
          `Run ${busy.id} of this session has not ended; stop it, wait for it, or mark it as interrupted`,
        );
      const now = host.now();
      store.run(
        `INSERT INTO hermes_chat_runs (id, session_id, input, run_key, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'sending', ?, ?)`,
        id,
        sessionId,
        request.text,
        id,
        now,
        now,
      );
    });
    return c.json({ run: await post(id) }, 201);
  });

  // Only the user's click sends again, and only a post that got no answer: the same key and the identical body.
  host.routes.post("/chat/runs/:id/retry", async (c) => {
    const row = found(c.req.param("id"));
    if (row.state !== "sending")
      throw new ApiError(409, "hermes_run_sent", `Run ${row.id} reached Hermes; nothing to retry`);
    if (host.now() - row.created_at >= KEY_RETENTION_MS) {
      // Hermes may have dropped the key, so the same post could start the run a second time. Sending nothing frees the
      // session; the first try may still have run.
      update(row.id, {
        state: "failed",
        error:
          "pi-spore did not send it again: Hermes keeps a key for 24 h only, so a retry now could run it twice. The first try may have reached Hermes; check the transcript.",
      });
      return c.json({ run: await publishRun(row.id) });
    }
    return c.json({ run: await post(row.id) });
  });

  host.routes.post("/chat/runs/:id/stop", async (c) => {
    const row = found(c.req.param("id"));
    if (!row.run_id || ENDED.has(row.state))
      throw new ApiError(409, "hermes_run_ended", `Run ${row.id} is not running`);
    update(row.id, { stop_requested: 1 });
    try {
      await hermes.stop(row.run_id);
    } catch (error) {
      // The stop did not get through, so the page must not say the run was stopped.
      update(row.id, { stop_requested: 0 });
      await publishRun(row.id);
      throw error;
    }
    await applyRun(row.id, await hermes.getRun(row.run_id));
    return c.json({ run: await publishRun(row.id) });
  });

  host.routes.post("/chat/runs/:id/controls/:promptId", async (c) => {
    const row = found(c.req.param("id"));
    const request = parseJsonBody(AnswerHermesControlRequest, await c.req.text(), "answer");
    try {
      await controls.answer(row.id, row.run_id as string, c.req.param("promptId"), request);
    } finally {
      // Answered or expired: the inline card changes either way.
      await publishRun(row.id);
    }
    return c.json({ run: await viewOf(row.id) });
  });

  host.routes.get("/chat/runs/:id/reconcile", async (c) =>
    c.json(await runFacts(hermes, found(c.req.param("id")))),
  );

  host.routes.post("/chat/runs/:id/resolve", async (c) => {
    const row = found(c.req.param("id"));
    parseJsonBody(ResolveHermesChatRunRequest, await c.req.text(), "pick");
    // One pick only: the request that claims the row acts, so a double click sends nothing twice.
    const { changes } = store.run(
      "UPDATE hermes_chat_runs SET resolution = 'interrupted', updated_at = ? WHERE id = ? AND state = 'unknown' AND resolution IS NULL",
      host.now(),
      row.id,
    );
    if (changes === 0)
      throw new ApiError(409, "hermes_run_not_unknown", `Run ${row.id} waits for no pick`);
    let status: Run["status"] | undefined;
    try {
      if (!row.run_id) throw new ApiError(409, "hermes_no_run", `Run ${row.id} has no Hermes run`);
      // The exact pair from the run status now (spike Q3).
      const run = await hermes.getRun(row.run_id);
      status = run.status;
      const admission = run.admission_id ?? row.admission_id;
      const generation = run.execution_generation ?? row.execution_generation;
      if (admission == null || generation == null)
        throw new ApiError(
          409,
          "hermes_no_admission",
          `Hermes names no admission for run ${row.run_id}`,
        );
      await hermes.resolveUnknown(row.run_id, {
        admission_id: admission,
        execution_generation: generation,
      });
    } catch (error) {
      // A run Hermes no longer calls unknown has its own end; store it, so the session is free again.
      update(
        row.id,
        status !== undefined && status !== "unknown"
          ? { state: status, error: null, resolution: null }
          : { resolution: null },
      );
      await publishRun(row.id);
      homeItems.changed();
      throw error;
    }
    update(row.id, { state: "interrupted" });
    homeItems.changed();
    return c.json({ run: await publishRun(row.id) });
  });
}
