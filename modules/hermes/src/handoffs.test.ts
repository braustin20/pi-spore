// Handoffs to a FAKE Hermes with the FAKE Pi (card Hermes 1.2). Passing tests here are not live proof: that is card
// Hermes 1.5.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@pi-spore/mod-agents/server";
import type { ChatState, HermesHandoff, HermesReconcile, Inbox } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STREAM_IDLE_MS } from "./client.js";
import { type Harness, harness, TIMEOUT_MS } from "./test-helpers.js";

let scratch: string;
let open: Harness[];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-hermes-ask-")));
  open = [];
});
afterEach(async () => {
  for (const h of open) await h.close();
  rmSync(scratch, { recursive: true, force: true });
});

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

/** A harness with a folder project, an in-place workspace, and its worker chat; `ask` calls the bridge as that chat. */
async function start(options: Parameters<typeof harness>[0] = {}, name = "app") {
  const h = await harness(options);
  open.push(h);
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
  const { project } = await json<{ project: { id: string } }>(
    await h.server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await json<{ workspace: { id: string } }>(
    await h.server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name,
      isolation: "in-place",
    }),
    201,
  );
  const { agent } = await json<{ agent: { id: string } }>(
    await h.server.request("POST", "/api/agents", { workspaceId: workspace.id }),
    201,
  );
  return {
    h,
    ...as(h, agent.id, workspace.id),
    agentId: agent.id,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

/** Bridge calls as one agent process, with its own token. */
function as(h: Harness, agentId: string, workspaceId: string, readOnly = false) {
  const token = h.server.agentTokens.issue({
    agentId,
    workspaceId,
    ...(readOnly ? { readOnly } : {}),
  });
  const headers = (receipt?: string) => ({
    "x-pi-spore-token": "",
    authorization: `Bearer ${token}`,
    ...(receipt ? { "idempotency-key": receipt } : {}),
  });
  return {
    token,
    ask: (body: unknown = { kind: "question", text: "ping?" }, receipt = "toolu_1") =>
      h.server.request("POST", "/api/bridge/hermes/asks", body, headers(receipt)),
    cancelAsAgent: (id: string) =>
      h.server.request("POST", `/api/bridge/hermes/asks/${id}/cancel`, {}, headers("toolu_c")),
  };
}

async function handoff(h: Harness, id: string): Promise<HermesHandoff> {
  const { handoffs } = await json<{ handoffs: HermesHandoff[] }>(
    await h.server.request("GET", "/api/hermes/handoffs"),
  );
  const found = handoffs.find((entry) => entry.id === id);
  if (!found) throw new Error(`No handoff ${id}`);
  return found;
}

async function asked(response: Response): Promise<HermesHandoff> {
  return (await json<{ handoff: HermesHandoff }>(response, 201)).handoff;
}

/** Waits until the handoff has a run that Hermes runs, and returns it. */
async function running(h: Harness, id: string): Promise<HermesHandoff & { runId: string }> {
  await until(async () => (await handoff(h, id)).state === "running");
  return (await handoff(h, id)) as HermesHandoff & { runId: string };
}

async function state(h: Harness, id: string, wanted: HermesHandoff["state"]) {
  await until(async () => (await handoff(h, id)).state === wanted);
}

/** The user messages of an agent's chat. */
async function userMessages(h: Harness, agentId: string): Promise<string[]> {
  const [snapshot] = (await h.server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return (snapshot.chat as ChatState).messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string }[]).map((block) => block.text).join(""),
    );
}

async function answers(h: Harness, agentId: string, id: string) {
  return (await userMessages(h, agentId)).filter((text) =>
    text.startsWith(`Hermes answered your ask_hermes ${id}`),
  );
}

const runPosts = (h: Harness) =>
  h.fake.requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/v1/runs"),
  );
const posts = (h: Harness, suffix: string) =>
  h.fake.requests.filter((request) => request.method === "POST" && request.path.endsWith(suffix));

/** A run starts as `running` in the fake, so the handoff gets there once the job read it. */
async function askAndRun(setup: Awaited<ReturnType<typeof start>>, body?: unknown) {
  const sent = await asked(await setup.ask(body));
  return await running(setup.h, sent.id);
}

describe("ask_hermes handoffs (FAKE Hermes, FAKE Pi)", () => {
  it("submits one run in its own session, and delivers exactly one message with the result", async () => {
    const setup = await start();
    const { h, agentId } = setup;
    const sent = await asked(await setup.ask({ kind: "task", text: "List /tmp.", title: "tmp" }));
    expect(sent.state).toBe("pending");
    const run = await running(h, sent.id);
    expect(run.sessionId).toBe(`pi-spore-${sent.id}`);
    expect(run.provider).toBe("openai-codex");
    expect(run.model).toBe("gpt-6.1-sol");

    const [post] = runPosts(h);
    expect(post?.headers["idempotency-key"]).toBe(sent.id);
    const body = JSON.parse(post?.raw ?? "{}");
    // No provider or model override, and only the agent's text under the attribution header.
    expect(Object.keys(body)).toEqual(["input", "session_id"]);
    expect(body.session_id).toBe(`pi-spore-${sent.id}`);
    expect(body.input).toBe(
      `From pi-spore agent ${agentId}, project app, workspace app, handoff ${sent.id}.\n\nTask: tmp\n\nList /tmp.`,
    );

    h.fake.finish(run.runId, "pong");
    await state(h, sent.id, "completed");
    expect((await handoff(h, sent.id)).result).toBe("pong");
    await until(async () => (await answers(h, agentId, sent.id)).length > 0);
    expect(await answers(h, agentId, sent.id)).toEqual([
      `Hermes answered your ask_hermes ${sent.id} (completed): pong`,
    ]);
    // The key never reaches a log or an answer.
    expect(JSON.stringify(h.log)).not.toContain(h.key);
    expect(JSON.stringify(await handoff(h, sent.id))).not.toContain(h.key);
  });

  it("caps a long result in the message and keeps all of it on the handoff", async () => {
    const setup = await start();
    const run = await askAndRun(setup);
    const long = "x".repeat(5_000);
    setup.h.fake.finish(run.runId, long);
    await state(setup.h, run.id, "completed");
    expect((await handoff(setup.h, run.id)).result).toBe(long);
    await until(async () => (await answers(setup.h, setup.agentId, run.id)).length > 0);
    const [text] = await answers(setup.h, setup.agentId, run.id);
    expect(text?.length).toBeLessThan(4_500);
    expect(text).toContain("The full result is stored with the handoff");
  });

  it("gives one handoff and one Hermes run for a repeated receipt", async () => {
    const setup = await start();
    const first = await asked(await setup.ask());
    const again = await asked(await setup.ask());
    expect(again.id).toBe(first.id);
    await running(setup.h, first.id);
    expect(runPosts(setup.h)).toHaveLength(1);
  });

  it("retries a submit that timed out with the identical body and key, which gives one run", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.holdRuns = true;
    const sent = await asked(await setup.ask());
    await until(() => runPosts(h).length === 1);
    await until(() => h.timers.delays().includes(TIMEOUT_MS));
    await h.timers.fire(TIMEOUT_MS);
    await until(async () => (await handoff(h, sent.id)).error !== undefined);
    expect((await handoff(h, sent.id)).state).toBe("pending");
    h.fake.release();
    await until(() => h.jobTimers.delays().length > 0);
    await h.jobTimers.fireAll();
    await running(h, sent.id);
    const [first, second] = runPosts(h);
    expect(runPosts(h)).toHaveLength(2);
    expect(second?.raw).toBe(first?.raw);
    expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    // The fake admitted the first and replayed it for the second: one run only.
    expect(h.fake.run("run_fake1")).toBeDefined();
    expect(h.fake.run("run_fake2")).toBeUndefined();
  });

  it("resumes a dropped stream with Last-Event-ID, with no second run, and still gets the end", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.dropStreamAfter = 1;
    const run = await askAndRun(setup);
    h.fake.emit(run.runId, { event: "tool.started", tool: "terminal", preview: "ls /tmp" });
    h.fake.emit(run.runId, { event: "tool.completed", tool: "terminal", error: false });
    h.fake.finish(run.runId, "done");
    await state(h, run.id, "completed");
    const events = h.fake.requests.filter((request) => request.path.endsWith("/events"));
    expect(events.some((request) => request.headers["last-event-id"] !== undefined)).toBe(true);
    expect(runPosts(h)).toHaveLength(1);
    await until(async () => (await answers(h, setup.agentId, run.id)).length > 0);
    expect(await answers(h, setup.agentId, run.id)).toHaveLength(1);
  });

  it("resumes the job after a pi-spore restart and delivers once", async () => {
    const home = join(scratch, "home");
    const setup = await start({ home });
    const run = await askAndRun(setup);
    open.splice(open.indexOf(setup.h), 1);
    await setup.h.close({ keepFake: true });
    // The fake stays up; the second server is pi-spore after the restart.
    const second = await harness({ home, firstId: 10_000, reuse: setup.h });
    open.push(second);
    second.fake.finish(run.runId, "after restart");
    await state(second, run.id, "completed");
    await until(async () => (await answers(second, setup.agentId, run.id)).length > 0);
    expect(await answers(second, setup.agentId, run.id)).toEqual([
      `Hermes answered your ask_hermes ${run.id} (completed): after restart`,
    ]);
    expect(runPosts(second)).toHaveLength(1);
    await setup.h.fake.close();
  });

  it("marks a run that a Hermes restart left unknown as uncertain, shows what is known, and waits for the user", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.emit(run.runId, { event: "tool.started", tool: "terminal", preview: "rm -r /tmp/x" });
    await until(
      async () => (await handoff(h, run.id)).state === "running" && h.fake.requests.length > 0,
    );
    await until(async () => {
      const reconcile = await json<HermesReconcile>(
        await h.server.request("GET", `/api/hermes/handoffs/${run.id}/reconcile`),
      );
      return reconcile.toolStarted !== undefined;
    });
    h.fake.restart();
    await state(h, run.id, "uncertain");
    await until(async () => (await answers(h, setup.agentId, run.id)).length > 0);
    const [text] = await answers(h, setup.agentId, run.id);
    expect(text).toContain("(uncertain)");
    expect(text).toContain("not undone");

    const reconcile = await json<HermesReconcile>(
      await h.server.request("GET", `/api/hermes/handoffs/${run.id}/reconcile`),
    );
    expect(reconcile.runStatus).toBe("unknown");
    expect(reconcile.toolStarted).toBe("terminal: rm -r /tmp/x");
    expect(reconcile.messages).toEqual([]);
    const inbox = await json<Inbox>(await h.server.request("GET", "/api/attention/inbox"));
    expect(
      inbox.items.some((item) => item.kind === "notice" && item.id === `uncertain:${run.id}`),
    ).toBe(true);
    // Nothing is resolved or sent again until the user picks.
    expect(posts(h, "/resolve-unknown")).toHaveLength(0);
    expect(runPosts(h)).toHaveLength(1);

    const picked = await json<{ handoff: HermesHandoff }>(
      await h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, {
        action: "interrupt",
      }),
    );
    expect(picked.handoff.resolution).toBe("interrupted");
    expect(picked.handoff.state).toBe("cancelled");
    const [resolve] = posts(h, "/resolve-unknown");
    expect(resolve?.raw).toBe('{"admission_id":"adm_fake1","execution_generation":1}');
    expect(runPosts(h)).toHaveLength(1);
  });

  it("sends again only on a confirmed pick, as a new handoff with a new session and key", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.restart();
    await state(h, run.id, "uncertain");
    const unconfirmed = await h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, {
      action: "resend",
    });
    expect(unconfirmed.status).toBe(400);
    expect(runPosts(h)).toHaveLength(1);
    const { handoff: old } = await json<{ handoff: HermesHandoff }>(
      await h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, {
        action: "resend",
        confirmed: true,
      }),
    );
    expect(old.resolution).toBe("resent");
    const fresh = await running(h, old.resentAs as string);
    expect(fresh.sessionId).toBe(`pi-spore-${fresh.id}`);
    const [first, second] = runPosts(h);
    expect(second?.headers["idempotency-key"]).toBe(fresh.id);
    expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
    // A second pick finds nothing to do.
    const twice = await h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, {
      action: "resend",
      confirmed: true,
    });
    expect(twice.status).toBe(409);
    expect(runPosts(h)).toHaveLength(2);
  });

  it("waits as pending while Hermes is offline, and sends when it is back", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.serverError = true;
    const sent = await asked(await setup.ask());
    await until(
      async () => (await handoff(h, sent.id)).error?.startsWith("Hermes is offline") === true,
    );
    expect((await handoff(h, sent.id)).state).toBe("pending");
    expect(runPosts(h)).toHaveLength(0);
    h.fake.options.serverError = false;
    await until(() => h.jobTimers.delays().length > 0);
    await h.jobTimers.fireAll();
    await running(h, sent.id);
    expect(runPosts(h)).toHaveLength(1);
  });

  it("fails a handoff that waited for Hermes past hermes.offlineWaitHours", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.serverError = true;
    const sent = await asked(await setup.ask());
    await until(async () => (await handoff(h, sent.id)).error !== undefined);
    h.server.advance(24 * 3_600_000);
    await until(() => h.jobTimers.delays().length > 0);
    await h.jobTimers.fireAll();
    await state(h, sent.id, "failed");
    await until(async () => (await answers(h, setup.agentId, sent.id)).length > 0);
    expect((await answers(h, setup.agentId, sent.id))[0]).toContain(
      "could not be reached for 24 h",
    );
  });

  it("cancels a running handoff with stop, ends it cancelled, and says steps are not undone", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    await json(await h.server.request("POST", `/api/hermes/handoffs/${run.id}/cancel`, {}));
    await state(h, run.id, "cancelled");
    expect(posts(h, `/v1/runs/${run.runId}/stop`)).toHaveLength(1);
    await until(async () => (await answers(h, setup.agentId, run.id)).length > 0);
    const [text] = await answers(h, setup.agentId, run.id);
    expect(text).toContain("(cancelled)");
    expect(text).toContain("Steps Hermes completed are not undone");
  });

  it("lets the asking chat cancel its own handoff, and no other chat", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    const stranger = as(h, "01STRANGER", setup.workspaceId);
    expect((await stranger.cancelAsAgent(run.id)).status).toBe(404);
    expect(posts(h, "/stop")).toHaveLength(0);
    await json(await setup.cancelAsAgent(run.id));
    await state(h, run.id, "cancelled");
    expect(posts(h, "/stop")).toHaveLength(1);
  });

  it("cancels a pending handoff without a run at once", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.serverError = true;
    const sent = await asked(await setup.ask());
    await until(async () => (await handoff(h, sent.id)).error !== undefined);
    await json(await h.server.request("POST", `/api/hermes/handoffs/${sent.id}/cancel`, {}));
    expect((await handoff(h, sent.id)).state).toBe("cancelled");
    h.fake.options.serverError = false;
    await h.jobTimers.fireAll();
    expect(runPosts(h)).toHaveLength(0);
    expect(posts(h, "/stop")).toHaveLength(0);
  });
});

describe("cancel and uncertain picks, the hard cases (FAKE Hermes)", () => {
  const stopPath = (runId: string) => `/v1/runs/${runId}/stop`;

  it("cancels during a submit whose answer has not come back: same run, stopped, no second run", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.holdRuns = true;
    const sent = await asked(await setup.ask());
    await until(() => runPosts(h).length === 1);
    // Hermes admitted run_fake1, but its answer has not come back to pi-spore.
    h.fake.options.holdRuns = false;
    await json(await h.server.request("POST", `/api/hermes/handoffs/${sent.id}/cancel`, {}));
    await state(h, sent.id, "cancelled");
    expect(posts(h, stopPath("run_fake1"))).toHaveLength(1);
    const [first, second] = runPosts(h);
    expect(second?.raw).toBe(first?.raw);
    expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    expect(h.fake.run("run_fake1")?.status).toBe("cancelled");
    expect(h.fake.run("run_fake2")).toBeUndefined();
  });

  it("cancels after a submit timed out: it finds the run Hermes admitted and stops it", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.holdRuns = true;
    const sent = await asked(await setup.ask());
    await until(() => runPosts(h).length === 1);
    await until(() => h.timers.delays().includes(TIMEOUT_MS));
    await h.timers.fire(TIMEOUT_MS);
    await until(async () => (await handoff(h, sent.id)).error !== undefined);
    expect((await handoff(h, sent.id)).state).toBe("pending");
    h.fake.release();
    await json(await h.server.request("POST", `/api/hermes/handoffs/${sent.id}/cancel`, {}));
    await state(h, sent.id, "cancelled");
    expect(h.fake.run("run_fake1")?.status).toBe("cancelled");
    expect(posts(h, stopPath("run_fake1"))).toHaveLength(1);
    await until(async () => (await answers(h, setup.agentId, sent.id)).length > 0);
    expect(await answers(h, setup.agentId, sent.id)).toHaveLength(1);
  });

  it("ends uncertain when the stop fails, and later frames change nothing", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    // The follower's open stream keeps an idle timer; it goes when the follower closes the stream.
    await until(() => h.timers.delays().includes(STREAM_IDLE_MS));
    h.fake.options.answers[stopPath(run.runId)] = { status: 500, raw: "{}" };
    await json(await h.server.request("POST", `/api/hermes/handoffs/${run.id}/cancel`, {}));
    await state(h, run.id, "uncertain");
    expect((await handoff(h, run.id)).error).toContain("did not confirm the stop");
    h.fake.emit(run.runId, { event: "tool.started", tool: "terminal", preview: "ls" });
    h.fake.finish(run.runId, "late");
    await until(async () => (await answers(h, setup.agentId, run.id)).length > 0);
    // The old follower read the late frames and closed its stream; it must have written nothing.
    await until(() => !h.timers.delays().includes(STREAM_IDLE_MS));
    const after = await handoff(h, run.id);
    expect(after.state).toBe("uncertain");
    expect(after.result).toBeUndefined();
    expect(await answers(h, setup.agentId, run.id)).toHaveLength(1);
    const inbox = await json<Inbox>(await h.server.request("GET", "/api/attention/inbox"));
    expect(
      inbox.items.some((item) => item.kind === "notice" && item.id === `uncertain:${run.id}`),
    ).toBe(true);
  });

  it("ends uncertain when Hermes says stopping but the run does not end in 60 s", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.options.answers[stopPath(run.runId)] = {
      status: 200,
      raw: JSON.stringify({ run_id: run.runId, status: "stopping" }),
    };
    await json(await h.server.request("POST", `/api/hermes/handoffs/${run.id}/cancel`, {}));
    await until(() => h.jobTimers.delays().length > 0);
    expect((await handoff(h, run.id)).state).toBe("running");
    h.server.advance(60_000);
    await h.jobTimers.fireAll();
    await state(h, run.id, "uncertain");
    expect((await handoff(h, run.id)).error).toContain("did not end in 60 s");
    await until(async () => (await answers(h, setup.agentId, run.id)).length > 0);
    expect(await answers(h, setup.agentId, run.id)).toHaveLength(1);
  });

  it("keeps the result of a run that ended before its stop", async () => {
    const setup = await start();
    const { h } = setup;
    // The follower hears nothing, so only the cancel can see the end.
    h.fake.options.dropStreamAfter = 0;
    const run = await askAndRun(setup);
    h.fake.finish(run.runId, "done anyway");
    h.fake.options.answers[stopPath(run.runId)] = {
      status: 409,
      raw: JSON.stringify({ error: { code: "run_not_active" } }),
    };
    await json(await h.server.request("POST", `/api/hermes/handoffs/${run.id}/cancel`, {}));
    await state(h, run.id, "completed");
    expect((await handoff(h, run.id)).result).toBe("done anyway");
    await until(async () => (await answers(h, setup.agentId, run.id)).length > 0);
    const [text] = await answers(h, setup.agentId, run.id);
    expect(text).toContain("done anyway");
    expect(text).toContain("finished before the cancel took effect");
  });

  it("does not send again to find the run when a cancel comes after hermes.offlineWaitHours", async () => {
    const setup = await start({ settings: { offlineWaitHours: 1 } });
    const { h } = setup;
    h.fake.options.holdRuns = true;
    const sent = await asked(await setup.ask());
    await until(() => runPosts(h).length === 1);
    await until(() => h.timers.delays().includes(TIMEOUT_MS));
    await h.timers.fire(TIMEOUT_MS);
    await until(async () => (await handoff(h, sent.id)).error !== undefined);
    h.fake.release();
    h.server.advance(3_600_000);
    await json(await h.server.request("POST", `/api/hermes/handoffs/${sent.id}/cancel`, {}));
    await state(h, sent.id, "uncertain");
    expect((await handoff(h, sent.id)).error).toContain("did not send it again");
    expect(runPosts(h)).toHaveLength(1);
    expect(posts(h, "/stop")).toHaveLength(0);
  });

  it("takes the provider and model from the session record when a cancel ends the run", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.blankSessionMeta = true;
    const run = await askAndRun(setup);
    expect(run.provider).toBeUndefined();
    h.fake.setSessionMeta(`pi-spore-${run.id}`, {
      model: "gpt-6.1-sol",
      billing_provider: "openai-codex",
    });
    await json(await h.server.request("POST", `/api/hermes/handoffs/${run.id}/cancel`, {}));
    await state(h, run.id, "cancelled");
    expect(await handoff(h, run.id)).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
    });
  });

  it("drops an uncertain handoff on the user's pick, once, and clears its Home item", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.restart();
    await state(h, run.id, "uncertain");
    const [one, two] = await Promise.all([
      h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, { action: "drop" }),
      h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, { action: "drop" }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect((await handoff(h, run.id)).resolution).toBe("dropped");
    const inbox = await json<Inbox>(await h.server.request("GET", "/api/attention/inbox"));
    expect(
      inbox.items.some((item) => item.kind === "notice" && item.id === `uncertain:${run.id}`),
    ).toBe(false);
    expect(posts(h, "/resolve-unknown")).toHaveLength(0);
    expect(runPosts(h)).toHaveLength(1);
  });

  it("sends resolve-unknown once for a double click on Mark as interrupted", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.restart();
    await state(h, run.id, "uncertain");
    const [one, two] = await Promise.all([
      h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, { action: "interrupt" }),
      h.server.request("POST", `/api/hermes/handoffs/${run.id}/resolve`, { action: "interrupt" }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(posts(h, "/resolve-unknown")).toHaveLength(1);
  });
});

describe("ask_hermes edge cases (FAKE Hermes)", () => {
  it("gives one handoff and one run for two requests with the same receipt at once", async () => {
    const setup = await start();
    const [one, two] = await Promise.all([setup.ask(), setup.ask()]);
    const first = await asked(one);
    const second = await asked(two);
    expect(second.id).toBe(first.id);
    await running(setup.h, first.id);
    expect(runPosts(setup.h)).toHaveLength(1);
  });

  it("lists only one workspace's handoffs for the Details panel", async () => {
    const setup = await start();
    const sent = await asked(await setup.ask());
    const list = async (workspaceId: string) =>
      (
        await json<{ handoffs: HermesHandoff[] }>(
          await setup.h.server.request("GET", `/api/hermes/handoffs?workspaceId=${workspaceId}`),
        )
      ).handoffs.map((entry) => entry.id);
    expect(await list(setup.workspaceId)).toEqual([sent.id]);
    expect(await list("01OTHER")).toEqual([]);
  });

  it("does not send after hermes.offlineWaitHours passed, even when Hermes is back", async () => {
    const setup = await start({ settings: { offlineWaitHours: 1 } });
    const { h } = setup;
    h.fake.options.serverError = true;
    const sent = await asked(await setup.ask());
    await until(async () => (await handoff(h, sent.id)).error !== undefined);
    h.server.advance(3_600_000);
    h.fake.options.serverError = false;
    await until(() => h.jobTimers.delays().length > 0);
    await h.jobTimers.fireAll();
    await state(h, sent.id, "failed");
    expect((await handoff(h, sent.id)).error).toContain("could not be reached for 1 h");
    expect(runPosts(h)).toHaveLength(0);
  });

  it("takes the provider and model from the session record once Hermes fills them in", async () => {
    const setup = await start();
    const { h } = setup;
    h.fake.options.blankSessionMeta = true;
    const run = await askAndRun(setup);
    expect(run.provider).toBeUndefined();
    expect(run.model).toBeUndefined();
    h.fake.setSessionMeta(`pi-spore-${run.id}`, {
      model: "gpt-6.1-sol",
      billing_provider: "openai-codex",
    });
    h.fake.finish(run.runId, "pong");
    await state(h, run.id, "completed");
    expect(await handoff(h, run.id)).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
    });
  });

  it("stores the end of a handoff whose chat is gone, and delivers to nobody", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.server.store.run("UPDATE hermes_handoffs SET agent_id = '01GONE' WHERE id = ?", run.id);
    h.fake.finish(run.runId, "pong");
    await state(h, run.id, "completed");
    expect(h.log.some((line) => line.message === "The chat that asked Hermes is gone")).toBe(true);
  });

  it.each([
    ["unauthorized", (h: Harness) => writeFileSync(h.keyFile, "fake-wrong-key", { mode: 0o600 })],
    [
      "incompatible",
      (h: Harness) => {
        h.fake.options.version = "0.24.0";
      },
    ],
  ])("refuses an ask while Hermes is %s, and starts nothing", async (status, breakIt) => {
    const setup = await start();
    breakIt(setup.h);
    const refused = await setup.ask();
    expect(refused.status).toBe(503);
    expect((await refused.json()).error.message).toContain(`Hermes is ${status}`);
    expect(runPosts(setup.h)).toHaveLength(0);
    const { handoffs } = await json<{ handoffs: unknown[] }>(
      await setup.h.server.request("GET", "/api/hermes/handoffs"),
    );
    expect(handoffs).toEqual([]);
  });
});

describe("Hermes approvals and clarify questions go to the user on Home", () => {
  const inboxNotices = async (h: Harness) =>
    (await json<Inbox>(await h.server.request("GET", "/api/attention/inbox"))).items.filter(
      (item) => item.kind === "notice" && item.source === "hermes",
    );
  const answer = (h: Harness, id: string, promptId: string, body: unknown) =>
    h.server.request("POST", `/api/hermes/handoffs/${id}/controls/${promptId}`, body);
  const control = async (h: Harness, id: string, promptId: string) => {
    await until(async () =>
      (await handoff(h, id)).controls.some((entry) => entry.promptId === promptId),
    );
    return (await handoff(h, id)).controls.find((entry) => entry.promptId === promptId);
  };

  it("shows an approval on Home and posts the user's once with the exact body, once", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.requestApproval(run.runId, "prompt-1");
    expect((await control(h, run.id, "prompt-1"))?.command).toBe("rm -r /tmp/x");
    const [notice] = await inboxNotices(h);
    expect(notice).toMatchObject({ title: "Hermes asks to run a command", href: "#/hermes" });
    expect(notice?.kind === "notice" && notice.detail).toContain("rm -r /tmp/x");
    expect(notice?.kind === "notice" && notice.detail).toContain(`Handoff ${run.id}`);
    expect(notice?.kind === "notice" && notice.detail).toMatch(/\d+ s left/);

    // A double click: two posts at once, one answer to Hermes.
    const [one, two] = await Promise.all([
      answer(h, run.id, "prompt-1", { choice: "once" }),
      answer(h, run.id, "prompt-1", { choice: "once" }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const sent = posts(h, "/approval");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.raw).toBe('{"request_id":"prompt-1","execution_generation":1,"choice":"once"}');
    expect((await control(h, run.id, "prompt-1"))?.state).toBe("answered");
    await until(async () => (await inboxNotices(h)).length === 0);
  });

  it("posts deny with the exact body, and refuses session, always, and an agent token", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.requestApproval(run.runId, "prompt-2");
    await control(h, run.id, "prompt-2");
    expect((await answer(h, run.id, "prompt-2", { choice: "always" })).status).toBe(400);
    expect((await answer(h, run.id, "prompt-2", { choice: "session" })).status).toBe(400);
    const asAgent = await h.server.request(
      "POST",
      `/api/hermes/handoffs/${run.id}/controls/prompt-2`,
      { choice: "once" },
      { "x-pi-spore-token": "", authorization: `Bearer ${setup.token}` },
    );
    expect(asAgent.status).toBe(401);
    expect(posts(h, "/approval")).toHaveLength(0);
    await json(await answer(h, run.id, "prompt-2", { choice: "deny" }));
    expect(posts(h, "/approval")[0]?.raw).toBe(
      '{"request_id":"prompt-2","execution_generation":1,"choice":"deny"}',
    );
  });

  it("shows expired and sends nothing more for a stale generation or a timed-out approval", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.requestApproval(run.runId, "prompt-3");
    await control(h, run.id, "prompt-3");
    // Hermes moved to a new generation since the control was read.
    (h.fake.run(run.runId) as { execution_generation: number }).execution_generation = 2;
    const stale = await answer(h, run.id, "prompt-3", { choice: "once" });
    expect(stale.status).toBe(409);
    expect((await control(h, run.id, "prompt-3"))?.state).toBe("expired");
    expect((await answer(h, run.id, "prompt-3", { choice: "once" })).status).toBe(409);
    expect(posts(h, "/approval")).toHaveLength(1);

    h.fake.requestApproval(run.runId, "prompt-4");
    await control(h, run.id, "prompt-4");
    h.server.advance(301_000);
    expect(await inboxNotices(h)).toHaveLength(0);
    const late = await answer(h, run.id, "prompt-4", { choice: "once" });
    expect(late.status).toBe(409);
    expect((await control(h, run.id, "prompt-4"))?.state).toBe("expired");
    expect(posts(h, "/approval")).toHaveLength(1);
  });

  it("shows no Home item and no list once hermes.enabled is off", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.requestApproval(run.runId, "prompt-6");
    await control(h, run.id, "prompt-6");
    expect(await inboxNotices(h)).toHaveLength(1);
    h.settings({});
    expect(await inboxNotices(h)).toHaveLength(0);
    expect(
      await json<{ enabled: boolean; handoffs: unknown[] }>(
        await h.server.request("GET", "/api/hermes/handoffs"),
      ),
    ).toEqual({ enabled: false, handoffs: [] });
  });

  it("does not post again after an answer Hermes took whose reply was lost", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.requestApproval(run.runId, "prompt-5");
    await control(h, run.id, "prompt-5");
    h.fake.options.loseAnswers = true;
    const lost = await answer(h, run.id, "prompt-5", { choice: "once" });
    expect(lost.status).toBe(502);
    expect((await control(h, run.id, "prompt-5"))?.state).toBe("answered");
    h.fake.options.loseAnswers = false;
    expect((await answer(h, run.id, "prompt-5", { choice: "once" })).status).toBe(409);
    expect(posts(h, "/approval")).toHaveLength(1);
  });

  it("shows a clarify question on Home and posts the answer with the exact body", async () => {
    const setup = await start();
    const { h } = setup;
    const run = await askAndRun(setup);
    h.fake.requestClarify(run.runId, "clarify-1");
    expect((await control(h, run.id, "clarify-1"))?.question).toBe("ping or pong?");
    const [notice] = await inboxNotices(h);
    expect(notice).toMatchObject({ title: "Hermes asks you a question" });
    expect(notice?.kind === "notice" && notice.detail).toContain("ping or pong?");
    await json(await answer(h, run.id, "clarify-1", { answer: "pong" }));
    expect(posts(h, "/clarify")[0]?.raw).toBe(
      '{"request_id":"clarify-1","execution_generation":1,"answer":"pong"}',
    );
  });
});

describe("who may ask Hermes", () => {
  it("refuses a read-only side chat", async () => {
    const setup = await start();
    const side = as(setup.h, setup.agentId, setup.workspaceId, true);
    const refused = await side.ask();
    expect(refused.status).toBe(403);
    expect(setup.h.fake.requests).toHaveLength(0);
  });

  it("lets the planner chat ask", async () => {
    const setup = await start();
    const { h } = setup;
    const { workspace } = await json<{ workspace: { id: string } }>(
      await h.server.request("POST", "/api/workspaces/planner", { projectId: setup.projectId }),
    );
    const { agent } = await json<{ agent: { id: string } }>(
      await h.server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    const planner = as(h, agent.id, workspace.id, true);
    await asked(await planner.ask());
  });

  it("refuses a pipeline stage chat", async () => {
    const setup = await start();
    const stage = setup.h.agents.createStage(setup.workspaceId, {
      role: "worker",
      title: "implement",
    });
    const refused = await as(setup.h, stage.id, setup.workspaceId).ask();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("hermes_refused");
    expect(setup.h.fake.requests).toHaveLength(0);
  });

  it("refuses a chat that works on a request from Hermes (the hop rule)", async () => {
    const setup = await start();
    // Card Hermes 1.3 writes incoming requests; this row stands in for one the chat works on.
    setup.h.server.store.run(
      `INSERT INTO hermes_handoffs (id, direction, agent_id, workspace_id, project_id, profile, kind, text, prompt,
       hop_count, state, run_key, idempotency_key, created_at, updated_at)
       VALUES ('01IN', 'in', ?, ?, ?, 'pi-spore', 'task', 'x', 'x', 1, 'running', 'k', 'r', 1, 1)`,
      setup.agentId,
      setup.workspaceId,
      setup.projectId,
    );
    const refused = await setup.ask();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toContain("no loops");
  });

  it("refuses every ask with hermes.enabled off, and sends Hermes nothing", async () => {
    const setup = await start({ enabled: false });
    const refused = await setup.ask();
    expect(refused.status).toBe(503);
    expect((await refused.json()).error.message).toContain("hermes.enabled");
    expect(setup.h.fake.requests).toHaveLength(0);
    const { handoffs } = await json<{ handoffs: unknown[] }>(
      await setup.h.server.request("GET", "/api/hermes/handoffs"),
    );
    expect(handoffs).toEqual([]);
  });
});
