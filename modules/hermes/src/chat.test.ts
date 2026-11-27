// The Hermes chat page's routes and relay against a FAKE Hermes (card Hermes 2.1). Passing tests here are not live
// proof: that is card Hermes 2.3.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let scratch: string;
beforeEach(() => {
  open = [];
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-hermes-chat-")));
});
afterEach(async () => {
  for (const h of open) await h.close();
  rmSync(scratch, { recursive: true, force: true });
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

/** The newest run view published for a run, as a live browser has it. */
function published(h: Harness, run: HermesChatRun): HermesChatRun {
  const views = events(h, run.sessionId).flatMap((event) =>
    event.type === "run" && event.run.id === run.id ? [event.run] : [],
  );
  const last = views.at(-1);
  if (!last) throw new Error(`No run event for ${run.id}`);
  return last;
}

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
    h.fake.emit("run_fake1", { event: "message.delta", delta: "po" });
    await reaches(h, run, (now) => now.textSeq === 1);
    // A browser that opens the session now gets the text so far and its count, so it skips the delta sent again.
    expect(await runOf(h, session.id, run.id)).toMatchObject({ text: "po", textSeq: 1 });
    h.fake.finish("run_fake1", "ng");
    const done = await reaches(h, run, (now) => now.state === "completed");
    expect(done).toMatchObject({ provider: "openai-codex", model: "gpt-6.1-sol" });
    expect(published(h, run)).toMatchObject({
      state: "completed",
      text: "pong",
      textSeq: 2,
      tools: [{ name: "terminal", preview: "ls /tmp", state: "done" }],
    });
    expect(events(h, session.id).filter((event) => event.type === "delta")).toEqual([
      { type: "delta", runId: run.id, delta: "po", seq: 1 },
      { type: "delta", runId: run.id, delta: "ng", seq: 2 },
    ]);

    const { messages } = await json<HermesChatMessages>(
      await h.server.request(
        "GET",
        `/api/hermes/chat/sessions/${session.id}/messages?limit=50&offset=0&order=oldest`,
      ),
    );
    // After a reload, the stored transcript holds the same reply the live stream showed.
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Reply with pong." },
      { role: "assistant", content: published(h, run).text },
    ]);
    expect(published(h, run).text).toBe("pong");
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
    await reaches(h, run, (now) => now.state === "completed");
    expect(published(h, run).text).toBe("pong it is");
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

    // The follower arms its wait after the failed status read; fire it only once it is there.
    await until(() => h.timers.delays().includes(RETRY_FIRST_MS));
    h.fake.options.serverError = false;
    h.fake.options.dropStreamAfter = undefined;
    await h.timers.fire(RETRY_FIRST_MS);
    await until(() => h.fake.requests.some((request) => request.headers["last-event-id"] === "0"));
    await reaches(h, run, (now) => now.reconnecting === undefined);
    h.fake.finish("run_fake1", "ng");
    await reaches(h, run, (now) => now.state === "completed");
    expect(published(h, run).text).toBe("pong");
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

    // No Drop: it would leave the session stuck behind the lost run.
    expect(
      (
        await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/resolve`, {
          action: "drop",
        })
      ).status,
    ).toBe(400);
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
    // The session is free again.
    expect((await send(h, session.id)).status).toBe(201);
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

  it("pages the stored transcript with limit, offset, and order", async () => {
    const h = await start();
    const session = await newSession(h);
    for (const [index, text] of ["one", "two"].entries()) {
      const run = await sent(h, session.id, `say ${text}`);
      await streaming(h, run);
      h.fake.finish(`run_fake${index + 1}`, text);
      await reaches(h, run, (now) => now.state === "completed");
    }
    const page = async (query: string) =>
      (
        await json<HermesChatMessages>(
          await h.server.request(
            "GET",
            `/api/hermes/chat/sessions/${session.id}/messages?${query}`,
          ),
        )
      ).messages.map((entry) => entry.content);
    expect(await page("limit=2&offset=2&order=oldest")).toEqual(["say two", "two"]);
    expect(await page("limit=1&offset=0&order=latest")).toEqual(["two"]);
    expect(await page("limit=2&offset=1&order=latest")).toEqual(["say two", "one"]);
    expect(
      (await h.server.request("GET", `/api/hermes/chat/sessions/${session.id}/messages?limit=0`))
        .status,
    ).toBe(400);
  });

  it("links a new session to a project, and refuses a project that does not exist", async () => {
    const h = await start();
    const folder = join(scratch, "app");
    mkdirSync(join(folder, ".pi-spore"), { recursive: true });
    writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
    const { project } = await json<{ project: { id: string } }>(
      await h.server.request("POST", "/api/projects", { path: folder }),
      201,
    );
    const { session } = await json<{ session: HermesChatSession }>(
      await h.server.request("POST", "/api/hermes/chat/sessions", {
        title: "With a project",
        projectId: project.id,
      }),
      201,
    );
    expect(session.projectId).toBe(project.id);
    const { sessions } = await json<HermesChatSessionList>(
      await h.server.request("GET", "/api/hermes/chat/sessions"),
    );
    expect(sessions.find((entry) => entry.id === session.id)?.projectId).toBe(project.id);
    const made = posts(h, "/api/sessions").length;
    expect(
      (
        await h.server.request("POST", "/api/hermes/chat/sessions", {
          title: "x",
          projectId: "01NOPROJECT",
        })
      ).status,
    ).toBe(404);
    expect(posts(h, "/api/sessions")).toHaveLength(made);
  });

  it("keeps a maybe-sent run as sending when a Retry finds Hermes not ready", async () => {
    const h = await start();
    const session = await newSession(h);
    h.fake.options.holdRuns = true;
    const pending = send(h, session.id);
    await until(() => runPosts(h).length === 1);
    await h.timers.fire(TIMEOUT_MS);
    const { run } = await json<{ run: HermesChatRun }>(await pending, 201);
    h.fake.options.holdRuns = false;
    h.settings({});
    const { run: refused } = await json<{ run: HermesChatRun }>(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/retry`, {}),
    );
    expect(refused.state).toBe("sending");
    expect(refused.error).toContain("An earlier try may have reached Hermes");
    expect(runPosts(h)).toHaveLength(1);
    // The session stays busy, so no second run can start beside the first.
    expect((await send(h, session.id)).status).toBe(409);
    h.settings({ enabled: true });
    const { run: retried } = await json<{ run: HermesChatRun }>(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/retry`, {}),
    );
    expect(retried.runId).toBe("run_fake1");
  });

  it("keeps a lost admission's session blocked past 24 h, and recovers only through the user's confirmed Retry", async () => {
    const h = await start();
    const session = await newSession(h);
    // Hermes admits the run, but its answer is lost; then Hermes restarts and the run is unknown.
    h.fake.options.holdRuns = true;
    const pending = send(h, session.id);
    await until(() => runPosts(h).length === 1);
    await h.timers.fire(TIMEOUT_MS);
    const { run } = await json<{ run: HermesChatRun }>(await pending, 201);
    expect(run.state).toBe("sending");
    h.fake.restart();
    h.fake.options.holdRuns = false;
    h.server.advance(24 * 3_600_000);

    // Without the confirm, nothing is sent, and the session stays blocked: Hermes may hold a run of it.
    const unconfirmed = await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/retry`, {});
    expect(unconfirmed.status).toBe(409);
    expect(((await unconfirmed.json()) as { error: { code: string } }).error.code).toBe(
      "hermes_retry_confirm",
    );
    expect(runPosts(h)).toHaveLength(1);
    expect((await runOf(h, session.id, run.id)).state).toBe("sending");
    expect((await send(h, session.id)).status).toBe(409);

    // The confirmed Retry sends the same key and body. Hermes still has the key of the unknown run, so it replays it.
    const { run: retried } = await json<{ run: HermesChatRun }>(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/retry`, { confirmed: true }),
    );
    expect(retried.runId).toBe("run_fake1");
    expect(runPosts(h)[1]?.raw).toBe(runPosts(h)[0]?.raw);
    expect(runPosts(h)[1]?.headers["idempotency-key"]).toBe(
      runPosts(h)[0]?.headers["idempotency-key"],
    );
    await reaches(h, run, (now) => now.state === "unknown");
    expect((await send(h, session.id)).status).toBe(409);
    await json(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/resolve`, {
        action: "interrupt",
      }),
    );
    // The session is free in Hermes too: a new run runs, it does not wait behind the lost one.
    const next = await sent(h, session.id, "And now?");
    expect(h.fake.run(next.runId as string)?.status).toBe("running");
  });

  it("follows a live run again after a pi-spore restart, and refills its text from the stream", async () => {
    const home = join(scratch, "home");
    const h = await start({ home });
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.emit("run_fake1", { event: "message.delta", delta: "po" });
    await reaches(h, run, (now) => now.text === "po");
    open.splice(open.indexOf(h), 1);
    await h.close({ keepFake: true });
    const streams = () => h.fake.requests.filter((r) => r.path.endsWith("/events")).length;
    const before = streams();
    const second = await start({ home, firstId: 10_000, reuse: h });
    // The restart alone follows the run: no browser has opened the session yet.
    await until(() => streams() > before);
    await until(() =>
      second.server.events
        .eventsOf(`${SESSION_TOPIC}${session.id}`)
        .some((event) => (event as HermesChatEvent).type === "delta"),
    );
    second.fake.finish("run_fake1", "ng");
    await until(() => {
      try {
        return published(second, run).state === "completed";
      } catch {
        return false;
      }
    });
    expect(published(second, run).text).toBe("pong");
    expect(runPosts(second)).toHaveLength(1);
    await h.fake.close();
  });

  it("sends Hermes nothing while it is off during a run, and follows again once it is on", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.settings({});
    // The poll's check (here: Reload) closes open streams.
    await h.server.request("POST", "/api/hermes/refresh", {});
    // Read from the events, not a snapshot: opening the session would follow the run again by itself.
    const view = () => {
      try {
        return published(h, run);
      } catch {
        return undefined;
      }
    };
    await until(() => view()?.reconnecting?.includes("turned off") === true);
    // The follower waits, wakes while Hermes is off, sends nothing, and waits again.
    await until(() => h.timers.delays().includes(RETRY_FIRST_MS));
    const before = h.fake.requests.length;
    await h.timers.fire(RETRY_FIRST_MS);
    await until(() => h.timers.delays().includes(2 * RETRY_FIRST_MS));
    expect(view()?.reconnecting).toContain("Hermes is off");
    expect(h.fake.requests.length).toBe(before);
    h.settings({ enabled: true });
    await h.timers.fire(2 * RETRY_FIRST_MS);
    await until(() => h.fake.requests.slice(before).some((r) => r.path.endsWith("/events")));
    await until(
      () => (h.fake.run("run_fake1") as { listeners?: Set<unknown> }).listeners?.size === 1,
    );
    h.fake.finish("run_fake1", "back");
    await until(() => view()?.state === "completed");
    expect(view()?.text).toBe("back");
  });

  it("shows a failed run with its error", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    (h.fake.run("run_fake1") as { status: string }).status = "failed";
    h.fake.emit("run_fake1", { event: "run.failed" });
    const failed = await reaches(h, run, (now) => now.state === "failed");
    expect(failed.error).toBe("Hermes says the run failed.");
    // The session is free again.
    expect((await send(h, session.id)).status).toBe(201);
  });

  it("does not say a run was stopped when the stop did not get through", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.options.serverError = true;
    expect(
      (await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/stop`, {})).status,
    ).toBe(502);
    expect(published(h, run)).toMatchObject({ state: "running", stopRequested: false });
  });

  it("opens an approval again when the answer was refused before sending", async () => {
    const h = await start();
    const session = await newSession(h);
    const run = await sent(h, session.id);
    await streaming(h, run);
    h.fake.requestApproval("run_fake1", "prompt-1");
    await reaches(h, run, (now) => now.controls.length === 1);
    h.settings({ keyFile: join(scratch, "missing.key") });
    const refused = await h.server.request(
      "POST",
      `/api/hermes/chat/runs/${run.id}/controls/prompt-1`,
      { choice: "once" },
    );
    expect(refused.status).toBe(503);
    expect(published(h, run).controls[0]?.state).toBe("open");
    expect(posts(h, "/approval")).toHaveLength(0);
    h.settings({ enabled: true });
    await json(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/controls/prompt-1`, {
        choice: "once",
      }),
    );
    expect(posts(h, "/approval")).toHaveLength(1);
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

  it("follows a queued run with no generation yet without Reconnecting, and uses its generation once it starts", async () => {
    const h = await start();
    h.fake.options.queueRuns = true;
    const session = await newSession(h);
    const run = await sent(h, session.id);
    // Hermes v0.23.3 sends `execution_generation: null` while the run is queued.
    await streaming(h, run);
    const queued = await runOf(h, session.id, run.id);
    expect(queued).toMatchObject({ state: "queued" });
    expect(queued.reconnecting).toBeUndefined();
    expect(queued.error).toBeUndefined();

    h.fake.startQueued("run_fake1");
    h.fake.requestApproval("run_fake1", "prompt-1");
    await reaches(h, run, (now) => now.controls.length === 1);
    await json(
      await h.server.request("POST", `/api/hermes/chat/runs/${run.id}/controls/prompt-1`, {
        choice: "once",
      }),
    );
    expect(posts(h, "/approval").map((request) => request.raw)).toEqual([
      '{"request_id":"prompt-1","execution_generation":1,"choice":"once"}',
    ]);
    h.fake.finish("run_fake1", "pong");
    const done = await reaches(h, run, (now) => now.state === "completed");
    expect(done.reconnecting).toBeUndefined();
    expect(
      events(h, session.id).some((event) => event.type === "run" && event.run.reconnecting),
    ).toBe(false);
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
