// The Hermes chat page's routes and relay against a FAKE Hermes (card Hermes 2.1). Passing tests here are not live
// proof: that is card Hermes 2.3.
import type {
  HermesChatEvent,
  HermesChatMessages,
  HermesChatRun,
  HermesChatSession,
  HermesChatSessionList,
  HermesRunFacts,
  Inbox,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RETRY_FIRST_MS, SESSION_TOPIC } from "./chat.js";
import { type Harness, harness, TIMEOUT_MS } from "./test-helpers.js";

let open: Harness[];
beforeEach(() => {
  open = [];
});
afterEach(async () => {
  for (const h of open) await h.close();
});

async function start(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  open.push(h);
  return h;
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const posts = (h: Harness, suffix: string) =>
  h.fake.requests.filter((request) => request.method === "POST" && request.path.endsWith(suffix));
const runPosts = (h: Harness) => posts(h, "/v1/runs");

async function newSession(h: Harness, title = "Ping test"): Promise<HermesChatSession> {
  return (
    await json<{ session: HermesChatSession }>(
      await h.server.request("POST", "/api/hermes/chat/sessions", { title }),
      201,
    )
  ).session;
}

const send = (h: Harness, sessionId: string, text = "Reply with pong.") =>
  h.server.request("POST", `/api/hermes/chat/sessions/${sessionId}/runs`, { text });

async function sent(h: Harness, sessionId: string, text?: string): Promise<HermesChatRun> {
  return (await json<{ run: HermesChatRun }>(await send(h, sessionId, text), 201)).run;
}

/** The snapshot a browser gets when it opens the session, as after a reload. */
async function snapshot(h: Harness, sessionId: string): Promise<HermesChatRun[]> {
  const [first] = (await h.server.events.snapshot(
    `${SESSION_TOPIC}${sessionId}`,
  )) as HermesChatEvent[];
  if (first?.type !== "snapshot") throw new Error("No snapshot");
  return first.runs;
}

async function runOf(h: Harness, sessionId: string, id: string): Promise<HermesChatRun> {
  const run = (await snapshot(h, sessionId)).find((entry) => entry.id === id);
  if (!run) throw new Error(`No run ${id}`);
  return run;
}

async function reaches(
  h: Harness,
  run: HermesChatRun,
  check: (run: HermesChatRun) => boolean,
): Promise<HermesChatRun> {
  await until(async () => check(await runOf(h, run.sessionId, run.id)));
  return await runOf(h, run.sessionId, run.id);
}

/** Waits until the relay follows the run's event stream. */
async function streaming(h: Harness, run: HermesChatRun) {
  await until(() =>
    h.fake.requests.some((request) => request.path.endsWith(`/v1/runs/${run.runId}/events`)),
  );
  await until(
    () => (h.fake.run(run.runId as string) as { listeners?: Set<unknown> }).listeners?.size === 1,
  );
}

const events = (h: Harness, sessionId: string) =>
  h.server.events.eventsOf(`${SESSION_TOPIC}${sessionId}`) as HermesChatEvent[];

const inboxNotices = async (h: Harness) =>
  (await json<Inbox>(await h.server.request("GET", "/api/attention/inbox"))).items.filter(
    (item) => item.kind === "notice" && item.source === "hermes-chat",
  );

describe("the Hermes chat page's server (FAKE Hermes)", () => {
  it("sends nothing to Hermes and lists nothing while hermes.enabled is off", async () => {
    const h = await start({ enabled: false });
    expect(
      await json<HermesChatSessionList>(await h.server.request("GET", "/api/hermes/chat/sessions")),
    ).toEqual({ enabled: false, sessions: [] });
    expect(
      (await h.server.request("POST", "/api/hermes/chat/sessions", { title: "x" })).status,
    ).toBe(503);
    expect(await inboxNotices(h)).toEqual([]);
    expect(h.fake.requests).toEqual([]);
  });

  it("makes a session, sends, relays the reply with tool rows, and restores it after a reload", async () => {
    const h = await start();
    const session = await newSession(h);
    expect(session).toMatchObject({ kind: "chat", source: "api_server", title: "Ping test" });
    expect(session.id).toMatch(/^pi-spore-chat-/);
    expect(session.readOnly).toBeUndefined();
    const run = await sent(h, session.id);
    expect(run.runId).toBe("run_fake1");
    // Exactly the input and the session: no provider or model override.
    expect(runPosts(h)[0]?.raw).toBe(
      JSON.stringify({ input: "Reply with pong.", session_id: session.id }),
    );
    expect(runPosts(h)[0]?.headers["idempotency-key"]).toBe(run.id);
    await streaming(h, run);
    h.fake.emit("run_fake1", { event: "tool.started", tool: "terminal", preview: "ls /tmp" });
    await reaches(h, run, (now) => now.tools.length === 1);
    expect((await runOf(h, session.id, run.id)).tools).toEqual([
      { name: "terminal", preview: "ls /tmp", state: "running" },
    ]);
    h.fake.emit("run_fake1", { event: "tool.completed", tool: "terminal", error: false });
    h.fake.finish("run_fake1", "pong");
    const done = await reaches(h, run, (now) => now.state === "completed");
    expect(done.text).toBe("pong");
    expect(done.tools).toEqual([{ name: "terminal", preview: "ls /tmp", state: "done" }]);
    expect(done).toMatchObject({ provider: "openai-codex", model: "gpt-6.1-sol" });
    expect(events(h, session.id)).toContainEqual({ type: "delta", runId: run.id, delta: "pong" });

    const { messages } = await json<HermesChatMessages>(
      await h.server.request(
        "GET",
        `/api/hermes/chat/sessions/${session.id}/messages?limit=50&offset=0&order=oldest`,
      ),
    );
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Reply with pong." },
      { role: "assistant", content: "pong" },
    ]);
    expect(h.fake.requests.find((request) => request.path.endsWith("/messages"))?.path).toContain(
      session.id,
    );
    expect(
      (await h.server.request("GET", `/api/hermes/chat/sessions/${session.id}/messages?order=up`))
        .status,
    ).toBe(400);
  });

  it("stops a run on the user's Stop and shows cancelled", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    const { run: stopped } = await json<{ run: HermesChatRun }>(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/stop`, {}),
    );
    expect(stopped).toMatchObject({ state: "cancelled", stopRequested: true });
    expect(posts(h, `/v1/runs/${run.runId}/stop`)).toHaveLength(1);
    expect(
      (await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/stop`, {})).status,
    ).toBe(409);
  });

  it("posts once and deny with the exact bodies, closes the Home item, and shows expired for a stale answer", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    const answer = (promptId: string, body: unknown) =>
      h.server.request("POST", `/api/hermes/chat/runs/${run.id}/controls/${promptId}`, body);

    h.fake.requestApproval("run_fake1", "prompt-1");
    const asked = await reaches(h, run, (now) => now.controls.length === 1);
    expect(asked.controls[0]).toMatchObject({
      kind: "approval",
      command: "rm -r /tmp/x",
      state: "open",
    });
    const [notice] = await inboxNotices(h);
    expect(notice).toMatchObject({
      title: "Hermes asks to run a command",
      href: `#/hermes/${session.id}`,
    });
    expect((await answer("prompt-1", { choice: "always" })).status).toBe(400);
    const { run: answered } = await json<{ run: HermesChatRun }>(
      await answer("prompt-1", { choice: "once" }),
    );
    expect(answered.controls[0]?.state).toBe("answered");
    expect(posts(h, "/approval").map((request) => request.raw)).toEqual([
      '{"request_id":"prompt-1","execution_generation":1,"choice":"once"}',
    ]);
    expect(await inboxNotices(h)).toEqual([]);

    h.fake.requestApproval("run_fake1", "prompt-2");
    await reaches(h, run, (now) => now.controls.some((c) => c.promptId === "prompt-2"));
    await json(await answer("prompt-2", { choice: "deny" }));
    expect(posts(h, "/approval")[1]?.raw).toBe(
      '{"request_id":"prompt-2","execution_generation":1,"choice":"deny"}',
    );

    h.fake.requestApproval("run_fake1", "prompt-3");
    await reaches(h, run, (now) => now.controls.some((c) => c.promptId === "prompt-3"));
    (h.fake.run("run_fake1") as { execution_generation: number }).execution_generation = 2;
    const stale = await answer("prompt-3", { choice: "once" });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "control_expired",
    );
    const expired = await runOf(h, session.id, run.id);
    expect(expired.controls.find((c) => c.promptId === "prompt-3")?.state).toBe("expired");
    expect(await inboxNotices(h)).toEqual([]);
    expect(posts(h, "/approval")).toHaveLength(3);
  });

  it("answers a clarify question with the exact body, and Hermes goes on", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.requestClarify("run_fake1", "clarify-1");
    const asked = await reaches(h, run, (now) => now.controls.length === 1);
    expect(asked.controls[0]).toMatchObject({ kind: "clarify", question: "ping or pong?" });
    expect(await inboxNotices(h)).toHaveLength(1);
    await json(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/controls/clarify-1`, {
        answer: "pong",
      }),
    );
    expect(posts(h, "/clarify")[0]?.raw).toBe(
      '{"request_id":"clarify-1","execution_generation":1,"answer":"pong"}',
    );
    h.fake.finish("run_fake1", "pong it is");
    const done = await reaches(h, run, (now) => now.state === "completed");
    expect(done.text).toBe("pong it is");
    expect(await inboxNotices(h)).toEqual([]);
  });

  it("shows Reconnecting while Hermes is down, and resumes with Last-Event-ID when it is back", async () => {
    const h = await start();
    const session = await newSession(h);
    // The stream breaks after its first frame, and Hermes then answers 503 to everything.
    h.fake.options.dropStreamAfter = 1;
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.options.serverError = true;
    h.fake.emit("run_fake1", { event: "message.delta", delta: "po" });
    const down = await reaches(h, run, (now) =>
      /^Reconnecting: Hermes answered 503/.test(now.reconnecting ?? ""),
    );
    expect(down.text).toBe("po");

    h.fake.options.serverError = false;
    h.fake.options.dropStreamAfter = undefined;
    await h.timers.fire(RETRY_FIRST_MS);
    await until(() => h.fake.requests.some((request) => request.headers["last-event-id"] === "0"));
    await reaches(h, run, (now) => now.reconnecting === undefined);
    h.fake.finish("run_fake1", "ng");
    const done = await reaches(h, run, (now) => now.state === "completed");
    expect(done.text).toBe("pong");
    // Nothing was posted again.
    expect(runPosts(h)).toHaveLength(1);
  });

  it("shows a run Hermes lost on restart as unknown, and sends resolve-unknown only on the user's pick", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.emit("run_fake1", { event: "tool.started", tool: "terminal", preview: "rm -r /tmp/x" });
    await reaches(h, run, (now) => now.tools.length === 1);
    h.fake.restart();
    const lost = await reaches(h, run, (now) => now.state === "unknown");
    expect(lost.error).toContain("not known");
    expect(await inboxNotices(h)).toEqual([
      expect.objectContaining({ title: "A Hermes chat run needs your decision" }),
    ]);
    expect(posts(h, "/resolve-unknown")).toHaveLength(0);
    expect(runPosts(h)).toHaveLength(1);
    // The session waits on the lost run.
    expect((await send(h, session.id)).status).toBe(409);

    const facts = await json<HermesRunFacts>(
      await h.server.request("GET", `/api/hermes/chat/runs/${run.id}/reconcile`),
    );
    expect(facts).toMatchObject({ runStatus: "unknown", toolStarted: "terminal: rm -r /tmp/x" });
    const { run: picked } = await json<{ run: HermesChatRun }>(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/resolve`, {
        action: "interrupt",
      }),
    );
    expect(picked).toMatchObject({ state: "interrupted", resolution: "interrupted" });
    expect(posts(h, "/resolve-unknown").map((request) => request.raw)).toEqual([
      '{"admission_id":"adm_fake1","execution_generation":1}',
    ]);
    expect(
      (
        await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/resolve`, {
          action: "interrupt",
        })
      ).status,
    ).toBe(409);
    expect(posts(h, "/resolve-unknown")).toHaveLength(1);
    expect(await inboxNotices(h)).toEqual([]);
  });

  it("does not post again on its own after a lost answer; Retry sends the same key and body", async () => {
    const h = await start();
    const session = await newSession(h);
    h.fake.options.holdRuns = true;
    const pending = send(h, session.id);
    await until(() => runPosts(h).length === 1);
    await h.timers.fire(TIMEOUT_MS);
    const { run } = await json<{ run: HermesChatRun }>(await pending, 201);
    expect(run.state).toBe("sending");
    expect(run.error).toContain("may have reached it");
    expect(runPosts(h)).toHaveLength(1);

    h.fake.options.holdRuns = false;
    const { run: retried } = await json<{ run: HermesChatRun }>(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/retry`, {}),
    );
    expect(retried.runId).toBe("run_fake1");
    const [first, second] = runPosts(h);
    expect(second?.raw).toBe(first?.raw);
    expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    expect(
      (await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/retry`, {})).status,
    ).toBe(409);
  });

  it("lists other sources and handoff sessions read-only, and never sends into them", async () => {
    const h = await start();
    const mine = await newSession(h);
    h.fake.addSession("cli-1", "cli");
    h.fake.addSession("setup-test", "api_server");
    await h.hermes.createSession({ id: "pi-spore-01HANDOFF", title: "handoff" });
    h.server.store.run(
      `INSERT INTO hermes_handoffs (id, direction, agent_id, workspace_id, project_id, profile, kind, text, prompt,
       hop_count, state, run_key, idempotency_key, session_id, created_at, updated_at)
       VALUES ('01HANDOFF', 'out', 'a', 'w', 'p', 'pi-spore', 'task', 't', 't', 1, 'completed', 'k', 'r',
       'pi-spore-01HANDOFF', 1, 1)`,
    );
    const { sessions } = await json<HermesChatSessionList>(
      await h.server.request("GET", "/api/hermes/chat/sessions"),
    );
    const byId = new Map(sessions.map((session) => [session.id, session]));
    expect(byId.get(mine.id)).toMatchObject({ kind: "chat" });
    expect(byId.get(mine.id)?.readOnly).toBeUndefined();
    expect(byId.get("cli-1")).toMatchObject({ kind: "foreign", readOnly: "Owned by cli" });
    expect(byId.get("setup-test")).toMatchObject({
      kind: "foreign",
      readOnly: "Not made by pi-spore's chat page",
    });
    expect(byId.get("pi-spore-01HANDOFF")).toMatchObject({
      kind: "handoff",
      readOnly: "A handoff session; read-only here",
    });
    for (const id of ["cli-1", "setup-test", "pi-spore-01HANDOFF"]) {
      const refused = await send(h, id);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "hermes_session_read_only",
      );
    }
    expect(runPosts(h)).toHaveLength(0);
    // Reading one is fine (ADR 0202 decision 11).
    expect((await h.server.request("GET", "/api/hermes/chat/sessions/cli-1/messages")).status).toBe(
      200,
    );
  });

  it("shows a blank provider and model as absent, not as an error", async () => {
    const h = await start();
    h.fake.options.blankSessionMeta = true;
    const session = await newSession(h);
    expect(session.provider).toBeUndefined();
    expect(session.model).toBeUndefined();
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.finish("run_fake1", "pong");
    const done = await reaches(h, run, (now) => now.state === "completed");
    expect(done.provider).toBeUndefined();
    expect(done.model).toBeUndefined();
    expect(done.error).toBeUndefined();
  });

  it("refuses agent tokens on every chat route", async () => {
    const h = await start();
    const session = await newSession(h);
    const token = h.server.agentTokens.issue({ agentId: "a1", workspaceId: "w1" });
    const asAgent = { "x-pi-spore-token": "", authorization: `Bearer ${token}` };
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/hermes/chat/sessions"],
      ["POST", "/api/hermes/chat/sessions", { title: "x" }],
      ["GET", `/api/hermes/chat/sessions/${session.id}/messages`],
      ["POST", `/api/hermes/chat/sessions/${session.id}/runs`, { text: "hi" }],
      ["POST", "/api/hermes/chat/runs/r1/stop", {}],
      ["POST", "/api/hermes/chat/runs/r1/retry", {}],
      ["POST", "/api/hermes/chat/runs/r1/controls/p1", { choice: "once" }],
      ["GET", "/api/hermes/chat/runs/r1/reconcile"],
      ["POST", "/api/hermes/chat/runs/r1/resolve", { action: "drop" }],
    ];
    for (const [method, path, body] of calls)
      expect((await h.server.request(method, path, body, asAgent)).status).toBe(401);
    expect(runPosts(h)).toHaveLength(0);
  });

  it("never puts the Hermes key in a route answer, an event, or the log", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.requestApproval("run_fake1", "prompt-1");
    await reaches(h, run, (now) => now.controls.length === 1);
    h.fake.finish("run_fake1", "pong");
    await reaches(h, run, (now) => now.state === "completed");
    const answers = [
      await (await h.server.request("GET", "/api/hermes/chat/sessions")).text(),
      await (
        await h.server.request("GET", `/api/hermes/chat/sessions/${session.id}/messages`)
      ).text(),
      JSON.stringify(await snapshot(h, session.id)),
      JSON.stringify(h.server.events.published),
      JSON.stringify(h.log),
    ];
    for (const text of answers) expect(text).not.toContain(h.key);
  });
});
