import { afterEach, describe, expect, it } from "vitest";
import { STREAM_IDLE_MS } from "./client.js";
import type { ApprovalAnswer, RunEventFrame } from "./server.js";
import { type Harness, harness, TIMEOUT_MS } from "./test-helpers.js";

// Every test runs against a FAKE Hermes (test-fixtures/fake-hermes.mjs). Passing here is not live proof.

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const ready = async () => {
  const setup = await harness();
  expect(await setup.hermes.status()).toMatchObject({ state: "ready" });
  setup.fake.requests.length = 0;
  return setup;
};

const runRequests = (setup: Harness) =>
  setup.fake.requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/v1/runs"),
  );

async function collect(frames: AsyncIterable<RunEventFrame>): Promise<RunEventFrame[]> {
  const seen: RunEventFrame[] = [];
  for await (const frame of frames) seen.push(frame);
  return seen;
}

describe("Hermes client runs", () => {
  it("retries startRun after a timeout with the same key and body, and gets the same run back", async () => {
    h = await ready();
    const session = await h.hermes.createSession({ id: "pi-spore-h1" });
    expect(session.source).toBe("api_server");
    h.fake.options.holdRuns = true;
    const body = { input: "Reply with the word pong.", session_id: "pi-spore-h1" };
    const first = h.hermes.startRun(body, "pi-spore-delivery-1");
    await expect.poll(() => runRequests(h as Harness).length).toBe(1);
    await h.timers.fire(TIMEOUT_MS);
    await expect(first).rejects.toMatchObject({ code: "hermes_timeout" });
    h.fake.release();

    const retry = await h.hermes.startRun(body, "pi-spore-delivery-1");
    const [sent, again] = runRequests(h);
    expect(again?.headers["idempotency-key"]).toBe("pi-spore-delivery-1");
    expect(again?.headers["idempotency-key"]).toBe(sent?.headers["idempotency-key"]);
    expect(again?.raw).toBe(sent?.raw);
    expect(retry).toMatchObject({ replayed: true });
    // The run the fake admitted first, and no second one.
    expect(retry.run_id).toBe("run_fake1");
    expect(h.fake.run("run_fake2")).toBeUndefined();
    expect(runRequests(h)).toHaveLength(2);
  });

  it("sends no provider or model, and refuses a body that sets one", async () => {
    h = await ready();
    await h.hermes.startRun({ input: "hi", session_id: "pi-spore-h2" }, "k-2");
    for (const request of h.fake.requests.filter((r) => r.raw !== "")) {
      const body = JSON.parse(request.raw) as Record<string, unknown>;
      expect(Object.keys(body)).not.toContain("model");
      expect(Object.keys(body)).not.toContain("provider");
    }
    const sneaky = { input: "hi", session_id: "pi-spore-h2", model: "x" };
    await expect(h.hermes.startRun(sneaky as never, "k-3")).rejects.toThrow(/model/);
    expect(runRequests(h)).toHaveLength(1);
  });

  it("answers 409 idempotency_key_conflict for a changed body under a used key", async () => {
    h = await ready();
    await h.hermes.startRun({ input: "pong", session_id: "s" }, "k-4");
    await expect(
      h.hermes.startRun({ input: "ping", session_id: "s" }, "k-4"),
    ).rejects.toMatchObject({ status: 409, code: "hermes_idempotency_key_conflict" });
  });

  it("is refused 409 permission_denied in a session whose source is not api_server", async () => {
    h = await ready();
    h.fake.addSession("users-chat", "cli");
    await expect(
      h.hermes.startRun({ input: "hi", session_id: "users-chat" }, "k-5"),
    ).rejects.toMatchObject({ status: 409, code: "hermes_permission_denied" });
  });

  it("reads a run with blank runtime fields as unknown, and the model from the session record", async () => {
    h = await ready();
    await h.hermes.createSession({ id: "pi-spore-h6", title: "pi-spore-h6" });
    const { run_id } = await h.hermes.startRun({ input: "hi", session_id: "pi-spore-h6" }, "k-6");
    const run = await h.hermes.getRun(run_id);
    expect(run).toMatchObject({ status: "running", runtime: { provider: "", model: "" } });
    const { data } = await h.hermes.listSessions({ source: "api_server" });
    expect(data).toEqual([
      expect.objectContaining({
        id: "pi-spore-h6",
        model: "gpt-6.1-sol",
        billing_provider: "openai-codex",
      }),
    ]);
    h.fake.finish(run_id, "pong");
    const messages = await h.hermes.sessionMessages("pi-spore-h6", { order: "oldest" });
    expect(messages.data.map((message) => message.content)).toEqual(["hi", "pong"]);
    await expect(h.hermes.getRun("run_missing")).rejects.toMatchObject({
      status: 404,
      code: "hermes_run_not_found",
    });
  });

  it("keeps the status of a refusal whose body is not JSON", async () => {
    h = await ready();
    h.fake.options.answers["/v1/runs/run_x"] = { status: 400, raw: "oops" };
    await expect(h.hermes.getRun("run_x")).rejects.toMatchObject({
      status: 400,
      code: "hermes_http_400",
    });
  });

  it("stops a run", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "sleep", session_id: "s" }, "k-7");
    expect(await h.hermes.stop(run_id)).toMatchObject({ run_id });
    expect(await h.hermes.getRun(run_id)).toMatchObject({ status: "cancelled" });
  });
});

describe("Hermes client events", () => {
  it("reads data-only frames to the end and resumes with Last-Event-ID", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-8");
    h.fake.finish(run_id, "pong");
    const all = await collect(h.hermes.runEvents(run_id));
    expect(all.map((frame) => [frame.id, frame.event.event])).toEqual([
      ["0", "message.delta"],
      ["1", "run.completed"],
    ]);
    expect(all[1]?.event).toMatchObject({ event: "run.completed", output: "pong" });
    const resumed = await collect(h.hermes.runEvents(run_id, "0"));
    expect(resumed.map((frame) => frame.id)).toEqual(["1"]);
    const events = h.fake.requests.filter((request) => request.path.endsWith("/events"));
    expect(events.map((request) => request.headers["last-event-id"])).toEqual([undefined, "0"]);
  });

  it("follows a live stream, skips an unknown event, and logs it once", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-9");
    const frames = collect(h.hermes.runEvents(run_id));
    await expect
      .poll(() => h?.fake.requests.some((request) => request.path.endsWith("/events")))
      .toBe(true);
    h.fake.emit(run_id, { event: "future.thing" });
    h.fake.emit(run_id, { event: "future.thing" });
    h.fake.emit(run_id, { event: "replay.truncated", oldest_retained_seq: 4 });
    h.fake.emit(run_id, { event: "tool.started", tool: "terminal", preview: "ls" });
    h.fake.finish(run_id, "done");
    const seen = await frames;
    expect(seen.map((frame) => frame.event.event)).toEqual([
      "replay.truncated",
      "tool.started",
      "message.delta",
      "run.completed",
    ]);
    expect(seen[0]?.event).toMatchObject({ oldest_retained_seq: 4 });
    expect(h.log.filter((line) => line.fields?.event === "future.thing")).toHaveLength(1);
  });

  it("refuses a known event without its required field", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-10");
    h.fake.emit(run_id, { event: "tool.started" });
    h.fake.finish(run_id, "x");
    await expect(collect(h.hermes.runEvents(run_id))).rejects.toMatchObject({
      code: "hermes_bad_response",
    });
  });

  it("refuses a frame that is not JSON or has no event name", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-raw");
    h.fake.emitRaw(run_id, "not json");
    h.fake.finish(run_id, "x");
    await expect(collect(h.hermes.runEvents(run_id))).rejects.toMatchObject({
      code: "hermes_bad_response",
      message: expect.stringContaining("not JSON"),
    });
    await expect(collect(h.hermes.runEvents(run_id, "0"))).resolves.toHaveLength(2);
    const other = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-raw-2");
    h.fake.emit(other.run_id, { delta: "no name" });
    await expect(collect(h.hermes.runEvents(other.run_id))).rejects.toMatchObject({
      code: "hermes_bad_response",
      message: expect.stringContaining("no event name"),
    });
  });

  it("closes an open stream when Hermes is turned off", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "sleep", session_id: "s" }, "k-off");
    h.fake.emit(run_id, { event: "message.delta", delta: "a" });
    const seen: RunEventFrame[] = [];
    const reading = (async () => {
      for await (const frame of (h as Harness).hermes.runEvents(run_id)) seen.push(frame);
    })();
    await expect.poll(() => seen.length).toBe(1);
    h.settings({});
    await h.server.request("POST", "/api/hermes/refresh");
    await expect(reading).rejects.toMatchObject({ code: "hermes_not_ready" });
    const before = h.fake.requests.length;
    h.fake.emit(run_id, { event: "message.delta", delta: "b" });
    await expect(h.hermes.getRun(run_id)).rejects.toMatchObject({ code: "hermes_not_ready" });
    expect(h.fake.requests).toHaveLength(before);
  });

  it("says the stream was lost when it drops before the run ends, then resumes", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-11");
    h.fake.emit(run_id, { event: "message.delta", delta: "a" });
    h.fake.emit(run_id, { event: "message.delta", delta: "b" });
    h.fake.options.dropStreamAfter = 1;
    const seen: RunEventFrame[] = [];
    await expect(
      (async () => {
        for await (const frame of h.hermes.runEvents(run_id)) seen.push(frame);
      })(),
    ).rejects.toMatchObject({ code: "hermes_stream_lost", message: expect.stringContaining("0") });
    expect(seen.map((frame) => frame.id)).toEqual(["0"]);
    h.fake.options.dropStreamAfter = undefined;
    h.fake.finish(run_id, "c");
    const rest = await collect(h.hermes.runEvents(run_id, "0"));
    expect(rest.map((frame) => frame.id)).toEqual(["1", "2", "3"]);
  });

  it("ends a stream that sends nothing, not even a keepalive, for 30 s as lost", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-idle");
    const seen: RunEventFrame[] = [];
    const reading = (async () => {
      for await (const frame of (h as Harness).hermes.runEvents(run_id)) seen.push(frame);
    })();
    h.fake.emit(run_id, { event: "message.delta", delta: "a" });
    await expect.poll(() => seen.length).toBe(1);
    // A frame armed the idle timer again; only silence after it ends the stream.
    await h.timers.fire(STREAM_IDLE_MS);
    await expect(reading).rejects.toMatchObject({
      code: "hermes_stream_lost",
      message: expect.stringContaining("sent nothing for 30 s"),
    });
    expect(h.timers.delays()).not.toContain(STREAM_IDLE_MS);
  });

  it("after a Hermes restart: events 404, the run is unknown, and only an explicit resolveUnknown clears it", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "sleep 600", session_id: "s" }, "k-12");
    h.fake.restart();
    await expect(collect(h.hermes.runEvents(run_id))).rejects.toMatchObject({
      status: 404,
      code: "hermes_run_not_found",
    });
    const run = await h.hermes.getRun(run_id);
    expect(run.status).toBe("unknown");
    // Nothing resolves it on its own.
    expect(h.fake.requests.some((request) => request.path.endsWith("/resolve-unknown"))).toBe(
      false,
    );
    const answer = await h.hermes.resolveUnknown(run_id, {
      admission_id: run.admission_id ?? "",
      execution_generation: run.execution_generation ?? 0,
    });
    expect(answer).toMatchObject({ run_id, status: "terminal" });
    expect(await h.hermes.getRun(run_id)).toMatchObject({ status: "cancelled" });
  });
});

describe("Hermes client approvals and clarify", () => {
  it("posts the exact approval body, and refuses session or always before any request", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "rm", session_id: "s" }, "k-13");
    h.fake.requestApproval(run_id, "prompt-1");
    const run = await h.hermes.getRun(run_id);
    expect(run).toMatchObject({
      status: "waiting_for_approval",
      pending_controls: [{ prompt_id: "prompt-1" }],
    });
    for (const choice of ["session", "always"]) {
      const answer = { request_id: "prompt-1", execution_generation: 1, choice } as unknown;
      await expect(h.hermes.answerApproval(run_id, answer as ApprovalAnswer)).rejects.toThrow(
        /choice/,
      );
    }
    expect(h.fake.requests.some((request) => request.path.endsWith("/approval"))).toBe(false);
    await h.hermes.answerApproval(run_id, {
      request_id: "prompt-1",
      execution_generation: 1,
      choice: "deny",
    });
    const sent = h.fake.requests.find((request) => request.path.endsWith("/approval"));
    expect(JSON.parse(sent?.raw ?? "")).toEqual({
      request_id: "prompt-1",
      execution_generation: 1,
      choice: "deny",
    });
  });

  it("answers a stale generation with 409 stale_generation", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "rm", session_id: "s" }, "k-14");
    h.fake.requestApproval(run_id, "prompt-2");
    await expect(
      h.hermes.answerApproval(run_id, {
        request_id: "prompt-2",
        execution_generation: 0,
        choice: "once",
      }),
    ).rejects.toMatchObject({ status: 409, code: "hermes_stale_generation" });
  });

  it("posts the exact clarify body", async () => {
    h = await ready();
    const { run_id } = await h.hermes.startRun({ input: "ask", session_id: "s" }, "k-15");
    h.fake.requestClarify(run_id, "prompt-3");
    await h.hermes.answerClarify(run_id, {
      request_id: "prompt-3",
      execution_generation: 1,
      answer: "pong",
    });
    const sent = h.fake.requests.find((request) => request.path.endsWith("/clarify"));
    expect(JSON.parse(sent?.raw ?? "")).toEqual({
      request_id: "prompt-3",
      execution_generation: 1,
      answer: "pong",
    });
  });
});

describe("Hermes key secrecy", () => {
  it("never puts the key in a log line, an error, or an API answer", async () => {
    h = await harness();
    const texts: string[] = [];
    const record = async (path: string) =>
      texts.push((await (await h?.server.request("GET", path))?.text()) ?? "");
    const failing = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        texts.push(String(error), JSON.stringify(error));
      }
    };
    await record("/api/hermes/status");
    await failing(
      () => h?.hermes.startRun({ input: "x", session_id: "s" }, "k-16") ?? Promise.resolve(),
    );
    await failing(
      () => h?.hermes.startRun({ input: "y", session_id: "s" }, "k-16") ?? Promise.resolve(),
    );
    await failing(() => h?.hermes.getRun("run_missing") ?? Promise.resolve());
    h.fake.options.serverError = true;
    await h.timers.fire(0);
    await failing(() => h?.hermes.listSessions() ?? Promise.resolve());
    h.fake.options.serverError = false;
    const { chmodSync } = await import("node:fs");
    chmodSync(h.keyFile, 0o644);
    await h.timers.fire(5_000);
    await record("/api/hermes/status");
    await failing(() => h?.hermes.listSessions() ?? Promise.resolve());
    // The log saw status changes, so it was written to.
    expect(h.log.length).toBeGreaterThan(0);
    texts.push(JSON.stringify(h.log));
    for (const text of texts) expect(text).not.toContain(h.key);
    // The key went only into Authorization headers.
    expect(
      h.fake.requests.some((request) => request.headers.authorization === `Bearer ${h?.key}`),
    ).toBe(true);
  });
});
