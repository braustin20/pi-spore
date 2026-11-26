// A FAKE Hermes API server for tests. It is not Hermes, and a test that passes against it is not live proof (that is
// card Hermes 1.5). It copies the shapes probed on Hermes v0.23.3 (docs/spikes/hermes-protocol.md):
//   - every path under /p/<profile>; /health needs no key, everything else needs `Authorization: Bearer <key>` (401);
//   - run admission with a durable `Idempotency-Key`: the same key and body replays the first run, a changed body is
//     409 idempotency_key_conflict;
//   - SSE frames with `id:` and `data:` only, the event name in `data.event`, `Last-Event-ID` replay;
//   - `restart()`: a run that had not ended becomes `unknown` and its event buffer is gone (events answer 404) until
//     `resolve-unknown` with the exact {admission_id, execution_generation};
//   - approval and clarify answers with exact bodies;
//   - 409 permission_denied for a run into a session whose source is not api_server or bot_room.
// Knobs on `fake.options`: version, missingFlag, falseFlag, models, serverError (5xx on every keyed request),
// holdRuns (admit POST /v1/runs but never answer, like a lost response), holdAll (never answer anything),
// dropStreamAfter (cut each event stream after n frames).
import { createServer } from "node:http";

const REQUIRED = {
  run_submission: true,
  run_status: true,
  run_events_sse: true,
  run_stop: true,
  run_approval_response: true,
  approval_events: true,
  session_resources: true,
  run_unknown_resolution: true,
};
const TERMINAL = new Set(["completed", "cancelled", "failed", "interrupted"]);
const VISIBLE = /^[\x21-\x7e]{1,255}$/;

const sameKeys = (body, keys) =>
  body !== null &&
  typeof body === "object" &&
  Object.keys(body).length === keys.length &&
  keys.every((key) => key in body);

/** Starts the fake on a free loopback port. */
export async function startFakeHermes({ key, profile = "pi-spore" }) {
  const options = { version: "0.23.3", models: [profile] };
  /** Every request: method, path (below the profile), headers, and the raw body. */
  const requests = [];
  const sessions = new Map();
  const runs = new Map();
  const admissions = new Map();
  const held = new Set();
  let counter = 0;

  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };
  const error = (response, status, code, message = code) =>
    json(response, status, { error: { code, message } });

  const emit = (run, data) => {
    const seq = run.events.length;
    const frame = { seq, data: { ...data, run_id: run.run_id, seq } };
    run.events.push(frame);
    for (const listener of run.listeners) listener(frame);
  };
  const end = (run, status, event, extra = {}) => {
    run.status = status;
    run.pending_controls = [];
    emit(run, { event, ...extra });
  };

  const view = (run) => {
    const { events: _events, listeners: _listeners, eventsLost: _lost, ...rest } = run;
    return rest;
  };

  const handleEvents = (request, response, run) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(": open\n\n");
    const after = request.headers["last-event-id"];
    const from = after === undefined ? 0 : Number(after) + 1;
    let sent = 0;
    const drop = options.dropStreamAfter;
    const write = (frame) => {
      if (drop !== undefined && sent >= drop) return;
      sent += 1;
      const text = `id: ${frame.seq}\ndata: ${JSON.stringify(frame.data)}\n\n`;
      // A drop resets the socket once the last frame is out, as a lost connection would.
      if (sent === drop) response.write(text, () => response.destroy());
      else response.write(text);
      if (TERMINAL.has(run.status) && frame.seq === run.events.length - 1) response.end();
    };
    for (const frame of run.events.slice(from)) write(frame);
    if (response.writableEnded || response.destroyed) return;
    if (TERMINAL.has(run.status)) {
      response.end();
      return;
    }
    run.listeners.add(write);
    response.on("close", () => run.listeners.delete(write));
  };

  const handle = (request, response, raw) => {
    const url = new URL(request.url, "http://fake");
    const prefix = `/p/${profile}`;
    // One gateway serves every profile, each with its own health.
    if (url.pathname === "/health" || /^\/p\/[^/]+\/health$/.test(url.pathname)) {
      json(response, 200, { status: "ok", platform: "hermes-agent", version: options.version });
      return;
    }
    if (!url.pathname.startsWith(`${prefix}/`)) return error(response, 404, "not_found");
    if (request.headers.authorization !== `Bearer ${key}`)
      return error(response, 401, "gateway_auth_failed", "Invalid or missing API key");
    if (options.serverError) return error(response, 503, "unavailable");
    const path = url.pathname.slice(prefix.length);
    let body;
    try {
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      return error(response, 400, "invalid_json");
    }

    if (request.method === "GET" && path === "/v1/capabilities") {
      const features = {
        ...REQUIRED,
        runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
        chat_completions: true,
      };
      if (options.falseFlag) features[options.falseFlag] = false;
      if (options.missingFlag) delete features[options.missingFlag];
      return json(response, 200, {
        object: "hermes.api_server.capabilities",
        platform: "hermes-agent",
        model: "hermes-agent",
        features,
      });
    }
    if (request.method === "GET" && path === "/v1/models")
      return json(response, 200, {
        object: "list",
        data: options.models.map((id) => ({ id, object: "model" })),
      });

    if (request.method === "POST" && path === "/v1/runs") {
      const idempotency = request.headers["idempotency-key"];
      if (typeof idempotency !== "string" || !VISIBLE.test(idempotency))
        return error(response, 400, "invalid_idempotency_key");
      const previous = admissions.get(idempotency);
      if (previous) {
        if (previous.raw !== raw)
          return error(
            response,
            409,
            "idempotency_key_conflict",
            "Idempotency-Key was already used with a different request payload",
          );
        const run = runs.get(previous.runId);
        return json(
          response,
          202,
          { run_id: run.run_id, status: run.status, replayed: true },
          { "idempotency-replayed": "true" },
        );
      }
      const session = sessions.get(body?.session_id);
      if (session && session.source !== "api_server" && session.source !== "bot_room")
        return error(response, 409, "permission_denied");
      counter += 1;
      const run = {
        run_id: `run_fake${counter}`,
        status: "running",
        admission_id: `adm_fake${counter}`,
        execution_generation: 1,
        session_id: body?.session_id,
        output: null,
        pending_controls: [],
        runtime: { provider: "", model: "" },
        input: body?.input,
        events: [],
        listeners: new Set(),
      };
      runs.set(run.run_id, run);
      admissions.set(idempotency, { raw, runId: run.run_id });
      if (options.holdRuns) {
        held.add(response);
        return;
      }
      return json(response, 202, { run_id: run.run_id, status: "started", replayed: false });
    }

    const runMatch = /^\/v1\/runs\/([^/]+)(\/[a-z-]+)?$/.exec(path);
    if (runMatch) {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      const action = runMatch[2];
      if (!run) return error(response, 404, "run_not_found");
      if (request.method === "GET" && action === undefined) return json(response, 200, view(run));
      if (request.method === "GET" && action === "/events") {
        if (run.eventsLost) return error(response, 404, "run_not_found");
        return handleEvents(request, response, run);
      }
      if (request.method === "POST" && action === "/stop") {
        if (!TERMINAL.has(run.status))
          end(run, "cancelled", "run.cancelled", { interrupted: true });
        return json(response, 200, {
          run_id: run.run_id,
          status: run.status === "cancelled" ? "cancelled" : "stopping",
          admission_id: run.admission_id,
        });
      }
      if (request.method === "POST" && (action === "/approval" || action === "/clarify")) {
        const keys =
          action === "/approval"
            ? ["request_id", "execution_generation", "choice"]
            : ["request_id", "execution_generation", "answer"];
        if (!sameKeys(body, keys)) return error(response, 400, "invalid_params");
        if (action === "/approval" && !["once", "session", "always", "deny"].includes(body.choice))
          return error(response, 400, "invalid_params");
        const control = run.pending_controls.find(
          (candidate) => candidate.prompt_id === body.request_id,
        );
        if (!control) return error(response, 400, "invalid_params");
        if (body.execution_generation !== run.execution_generation)
          return error(response, 409, "stale_generation");
        run.pending_controls = run.pending_controls.filter((candidate) => candidate !== control);
        run.status = "running";
        emit(run, {
          event: action === "/approval" ? "approval.responded" : "clarify.responded",
          request_id: body.request_id,
        });
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && action === "/resolve-unknown") {
        if (!sameKeys(body, ["admission_id", "execution_generation"]))
          return error(response, 400, "invalid_params");
        if (
          body.admission_id !== run.admission_id ||
          body.execution_generation !== run.execution_generation
        )
          return error(response, 409, "stale_generation");
        if (run.status !== "unknown") return error(response, 409, "not_unknown");
        run.status = "cancelled";
        return json(response, 200, {
          run_id: run.run_id,
          status: "terminal",
          outcome: "interrupted",
        });
      }
    }

    if (request.method === "POST" && path === "/api/sessions") {
      if (sessions.has(body?.id)) return error(response, 409, "session_exists");
      const session = {
        id: body.id,
        title: body.title ?? body.id,
        source: body.source ?? "api_server",
        message_count: 0,
        model: "gpt-6.1-sol",
        billing_provider: "openai-codex",
        messages: [],
      };
      sessions.set(session.id, session);
      const { messages: _messages, ...shown } = session;
      return json(response, 201, { object: "hermes.session", session: shown });
    }
    if (request.method === "GET" && path === "/api/sessions") {
      const source = url.searchParams.get("source");
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = [...sessions.values()]
        .filter((session) => source === null || session.source === source)
        .map(({ messages: _messages, ...shown }) => shown);
      return json(response, 200, {
        object: "list",
        data: all.slice(offset, offset + limit),
        limit,
        offset,
        has_more: offset + limit < all.length,
      });
    }
    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
    if (request.method === "GET" && messagesMatch) {
      const session = sessions.get(decodeURIComponent(messagesMatch[1]));
      if (!session) return error(response, 404, "session_not_found");
      return json(response, 200, { object: "list", data: session.messages, pagination: {} });
    }
    return error(response, 404, "not_found");
  };

  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url, "http://fake");
      requests.push({ method: request.method, path: url.pathname, headers: request.headers, raw });
      if (options.holdAll) {
        held.add(response);
        return;
      }
      handle(request, response, raw);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    options,
    requests,
    /** Adds a session as Hermes's own chats would have it, such as source `cli`. */
    addSession(id, source) {
      sessions.set(id, { id, title: id, source, message_count: 0, messages: [] });
    },
    /** Sends a delta and a completion, and stores the two messages in the run's session. */
    finish(runId, output) {
      const run = runs.get(runId);
      emit(run, { event: "message.delta", delta: output });
      run.output = output;
      end(run, "completed", "run.completed", { output, completed: true });
      const session = sessions.get(run.session_id);
      session?.messages.push(
        { id: session.messages.length + 1, role: "user", content: run.input },
        { id: session.messages.length + 2, role: "assistant", content: output },
      );
    },
    /** Sends any frame, such as an event name pi-spore does not know. */
    emit(runId, data) {
      emit(runs.get(runId), data);
    },
    requestApproval(runId, promptId) {
      const run = runs.get(runId);
      run.status = "waiting_for_approval";
      run.pending_controls.push({ prompt_id: promptId, kind: "approval", command: "rm -r /tmp/x" });
      emit(run, { event: "approval.request", request_id: promptId });
    },
    requestClarify(runId, promptId) {
      const run = runs.get(runId);
      run.pending_controls.push({
        prompt_id: promptId,
        kind: "clarify",
        question: "ping or pong?",
      });
      emit(run, { event: "clarify.request", request_id: promptId });
    },
    run: (runId) => runs.get(runId),
    /** Like a Hermes restart: open streams drop, event buffers are gone, runs that had not ended are `unknown`. */
    restart() {
      for (const run of runs.values()) {
        for (const listener of run.listeners) run.listeners.delete(listener);
        run.eventsLost = true;
        if (!TERMINAL.has(run.status)) run.status = "unknown";
      }
      server.closeAllConnections();
      held.clear();
    },
    /** Answers no more held requests; drops them. */
    release() {
      options.holdRuns = false;
      options.holdAll = false;
      for (const response of held) response.destroy();
      held.clear();
    },
    async close() {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
