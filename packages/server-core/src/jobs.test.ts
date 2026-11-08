import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStep, JobTimer, JobView, ServerModule, Store } from "@pi-spore/module-api";
import type { Job, JobList } from "@pi-spore/shared";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { createTestServer, type TestServer } from "./testing.js";

const EFFECTS = "CREATE TABLE t_effects (label TEXT NOT NULL)";

let scratch: string[] = [];
let servers: TestServer[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  servers = [];
  scratch = [];
});

type Options = NonNullable<Parameters<typeof createTestServer>[1]>;

async function open(modules: readonly ServerModule[], options: Options = {}): Promise<TestServer> {
  const server = await createTestServer(modules, options);
  servers.push(server);
  return server;
}

function shutdown(server: TestServer): void {
  server.close();
  servers = servers.filter((candidate) => candidate !== server);
}

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-spore-jobs-"));
  scratch.push(dir);
  return dir;
}

/** Lets timers-free async work run: a started job, its step, and its commit all finish within a few ticks. */
async function ticks(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve));
}

interface Gate {
  promise: Promise<void>;
  open(): void;
  fail(error: Error): void;
}

function gate(): Gate {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // The test may reject a gate before the step awaits it.
  promise.catch(() => {});
  return { promise, open, fail };
}

/** A JobTimer that records its delays and lets the test fire them. */
function fakeTimer() {
  const entries: { run: () => Promise<void>; ms: number; cancelled: boolean }[] = [];
  const timer: JobTimer = (run, ms) => {
    const entry = { run, ms, cancelled: false };
    entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { timer, live: () => entries.filter((entry) => !entry.cancelled) };
}

const effect = (store: Store, label: string) =>
  store.run("INSERT INTO t_effects (label) VALUES (?)", label);
const effects = (server: TestServer) =>
  server.store
    .all<{ label: string }>("SELECT label FROM t_effects ORDER BY rowid")
    .map((r) => r.label);

function testModule(define: (host: Parameters<ServerModule["setup"]>[0]) => void): ServerModule {
  return {
    id: "t",
    requires: [],
    core: false,
    setup(host) {
      host.store.migrate("t", [EFFECTS]);
      define(host);
    },
  };
}

/** A job with one step per subject name: it logs the name, waits on that name's gate, and writes an effect. */
function keyedModule(log: string[], gates: Record<string, Gate> = {}): ServerModule {
  return testModule((host) => {
    host.jobs.define<{ name: string }, never>("t.keyed", [
      {
        name: "only",
        async run(context) {
          log.push(context.subject.name);
          await gates[context.subject.name]?.promise;
          return { commit: () => effect(host.store, context.subject.name) };
        },
      },
    ]);
  });
}

function job(server: TestServer, id: string): JobView {
  const found = server.services.jobs.get(id);
  if (!found) throw new Error(`No job ${id}`);
  return found;
}

/** Three steps whose commits write effect rows. Step 2 can be held, and it sees step 1's checkpoint. */
function threeStepModule(log: string[], held?: Gate): ServerModule {
  return testModule((host) => {
    const steps: JobStep<unknown, { a: number }>[] = [
      {
        name: "one",
        async run() {
          log.push("one");
          return { checkpoint: { a: 1 }, commit: () => effect(host.store, "one") };
        },
      },
      {
        name: "two",
        async run(context) {
          log.push(`two:${context.checkpoint?.a}`);
          await held?.promise;
          return { commit: () => effect(host.store, "two") };
        },
      },
      {
        name: "three",
        async run() {
          log.push("three");
          return { commit: () => effect(host.store, "three") };
        },
      },
    ];
    host.jobs.define("t.three", steps);
  });
}

describe("a restart", () => {
  it("resumes a job on the step it was cut off in, and each effect exists once", async () => {
    const home = newHome();
    const log: string[] = [];
    const held = gate();
    const first = await open([threeStepModule(log, held)], { home });
    const id = first.services.jobs.start("t.three", {});
    await ticks();
    expect(log).toEqual(["one", "two:1"]);
    expect(job(first, id)).toMatchObject({ state: "running", step: "two" });
    shutdown(first);

    const second = await open([threeStepModule(log)], { home, firstId: 1_000 });
    await ticks();

    expect(log).toEqual(["one", "two:1", "two:1", "three"]);
    expect(effects(second)).toEqual(["one", "two", "three"]);
    expect(job(second, id).state).toBe("done");
    held.open();
    await ticks();
    expect(effects(second)).toEqual(["one", "two", "three"]);
  });

  it("runs a waiting job again", async () => {
    const home = newHome();
    let fail = true;
    const flaky = () =>
      testModule((host) => {
        host.jobs.define("t.flaky", [
          {
            name: "only",
            async run() {
              if (fail) throw new Error("boom");
              return {};
            },
          },
        ]);
      });
    const first = await open([flaky()], { home });
    const id = first.services.jobs.start("t.flaky", {});
    await ticks();
    expect(job(first, id)).toMatchObject({ state: "waiting", attempts: 1, error: "boom" });
    shutdown(first);

    fail = false;
    const second = await open([flaky()], { home, firstId: 1_000 });
    await ticks();

    expect(job(second, id)).toMatchObject({ state: "done", attempts: 0, error: null });
  });

  it("leaves jobs of a kind nobody defined as they are", async () => {
    const home = newHome();
    const { timer } = fakeTimer();
    const first = await open([keyedModule([])], { home, timer });
    const id = first.services.jobs.start("t.keyed", { name: "a" }, { after: 60_000 });
    await ticks();
    const before = job(first, id);
    shutdown(first);

    const second = await open([], { home, firstId: 1_000, startAt: 1_800_000_000_000 });
    await ticks();

    expect(job(second, id)).toEqual(before);
  });

  it("keeps the remaining delay of a job that was waiting for its time", async () => {
    const home = newHome();
    const log: string[] = [];
    const startAt = 1_700_000_000_000;
    const timerOne = fakeTimer();
    const first = await open([keyedModule(log)], { home, timer: timerOne.timer, startAt });
    const id = first.services.jobs.start("t.keyed", { name: "late" }, { after: 10_000 });
    await ticks();
    expect(timerOne.live()).toHaveLength(1);
    expect(timerOne.live()[0]?.ms).toBeGreaterThan(9_900);
    const runAt = job(first, id).runAt;
    shutdown(first);

    const timerTwo = fakeTimer();
    const second = await open([keyedModule(log)], {
      home,
      timer: timerTwo.timer,
      startAt: startAt + 6_000,
      firstId: 1_000,
    });
    await ticks();

    expect(log).toEqual([]);
    expect(job(second, id).runAt).toBe(runAt);
    expect(timerTwo.live()).toHaveLength(1);
    const remaining = timerTwo.live()[0]?.ms ?? 0;
    expect(remaining).toBeGreaterThan(3_900);
    expect(remaining).toBeLessThanOrEqual(4_010);
    await timerTwo.live()[0]?.run();
    expect(log).toEqual(["late"]);
    expect(job(second, id).state).toBe("done");
  });
});

describe("agent turns", () => {
  it("become interrupted after a restart, and a retry runs them", async () => {
    const home = newHome();
    const log: string[] = [];
    const held = gate();
    const agentModule = (hold?: Gate) =>
      testModule((host) => {
        host.jobs.define("t.agent", [
          {
            name: "turn",
            agentTurn: true,
            async run() {
              log.push("turn");
              await hold?.promise;
              return { commit: () => effect(host.store, "turn") };
            },
          },
        ]);
      });
    const first = await open([agentModule(held)], { home });
    const id = first.services.jobs.start("t.agent", {});
    await ticks();
    shutdown(first);

    const second = await open([agentModule()], { home, firstId: 1_000 });
    await ticks();
    expect(log).toEqual(["turn"]);
    expect(job(second, id).state).toBe("interrupted");
    const listed = await (await second.request("GET", "/api/jobs")).json();
    expect(listed).toMatchObject({ jobs: [{ id, state: "interrupted" }] });

    const retried = await second.request("POST", `/api/jobs/${id}/retry`);
    expect(retried.status).toBe(200);
    await ticks();

    expect(log).toEqual(["turn", "turn"]);
    expect(job(second, id).state).toBe("done");
    expect(effects(second)).toEqual(["turn"]);
  });
});

describe("a step", () => {
  it("rolls back its effect and checkpoint when its commit throws, then runs again", async () => {
    const seen: (number | undefined)[] = [];
    let failCommit = true;
    const server = await open([
      testModule((host) => {
        host.jobs.define<unknown, { a: number }>("t.commit", [
          {
            name: "one",
            async run(context) {
              seen.push(context.checkpoint?.a);
              return {
                checkpoint: { a: 1 },
                commit: () => {
                  effect(host.store, "one");
                  if (failCommit) throw new Error("commit failed");
                },
              };
            },
          },
        ]);
      }),
    ]);
    const id = server.services.jobs.start("t.commit", {});
    await ticks();

    expect(effects(server)).toEqual([]);
    expect(job(server, id)).toMatchObject({
      state: "waiting",
      attempts: 1,
      error: "commit failed",
    });
    expect(server.store.get("SELECT checkpoint FROM core_jobs WHERE id = ?", id)).toEqual({
      checkpoint: null,
    });

    failCommit = false;
    const retried = await server.request("POST", `/api/jobs/${id}/retry`);
    expect(retried.status).toBe(200);
    await ticks();

    expect(seen).toEqual([undefined, undefined]);
    expect(effects(server)).toEqual(["one"]);
    expect(job(server, id).state).toBe("done");
  });

  it("writes nothing when it finishes after the runner stopped", async () => {
    const log: string[] = [];
    const held = gate();
    const server = await open([threeStepModule(log, held)]);
    const id = server.services.jobs.start("t.three", {});
    await ticks();
    server.services.jobs.stop();

    held.open();
    await ticks();

    expect(effects(server)).toEqual(["one"]);
    expect(job(server, id)).toMatchObject({ state: "running", step: "two" });
  });

  it("runs the next step after the delay it asks for", async () => {
    const log: string[] = [];
    const { timer, live } = fakeTimer();
    const server = await open(
      [
        testModule((host) => {
          host.jobs.define("t.chain", [
            { name: "a", run: async () => ({ after: 5_000 }) },
            {
              name: "b",
              async run() {
                log.push("b");
                return {};
              },
            },
          ]);
        }),
      ],
      { timer },
    );
    const id = server.services.jobs.start("t.chain", {});
    await ticks();

    expect(log).toEqual([]);
    expect(job(server, id).step).toBe("b");
    expect(live()).toHaveLength(1);
    expect(live()[0]?.ms).toBeGreaterThan(4_900);
    await live()[0]?.run();
    expect(log).toEqual(["b"]);
    expect(job(server, id).state).toBe("done");
  });
});

describe("jobs with a key", () => {
  it("run one at a time in start order, while other keys run beside them", async () => {
    const log: string[] = [];
    const gates = { a: gate(), b: gate(), c: gate() };
    const server = await open([keyedModule(log, gates)]);
    const { jobs } = server.services;
    const a = jobs.start("t.keyed", { name: "a" }, { key: "k" });
    const b = jobs.start("t.keyed", { name: "b" }, { key: "k" });
    jobs.start("t.keyed", { name: "c" }, { key: "other" });
    await ticks();

    expect(log).toEqual(["a", "c"]);

    gates.a.open();
    await ticks();
    expect(log).toEqual(["a", "c", "b"]);
    expect(job(server, a).state).toBe("done");
    gates.b.open();
    gates.c.open();
    await ticks();
    expect(job(server, b).state).toBe("done");
  });

  it("are blocked by an older job that is waiting, until it is woken", async () => {
    const log: string[] = [];
    const gates: Record<string, Gate> = { a: gate() };
    gates.a?.fail(new Error("no"));
    const server = await open([keyedModule(log, gates)]);
    const { jobs } = server.services;
    const a = jobs.start("t.keyed", { name: "a" }, { key: "k" });
    const b = jobs.start("t.keyed", { name: "b" }, { key: "k" });
    await ticks();

    expect(job(server, a).state).toBe("waiting");
    expect(job(server, b).state).toBe("running");
    expect(log).toEqual(["a"]);

    delete gates.a;
    jobs.wake("t.keyed", "k");
    await ticks();

    expect(log).toEqual(["a", "a", "b"]);
    expect(job(server, b).state).toBe("done");
  });

  it("apply a wake that arrives while the step is running, once it settles", async () => {
    const held = gate();
    let runs = 0;
    const server = await open([
      testModule((host) => {
        host.jobs.define("t.latch", [
          {
            name: "only",
            async run() {
              runs++;
              if (runs > 1) return {};
              await held.promise;
              return { wait: true };
            },
          },
        ]);
      }),
    ]);
    const id = server.services.jobs.start("t.latch", {}, { key: "k" });
    await ticks();

    server.services.jobs.wake("t.latch", "k");
    held.open();
    await ticks();

    expect(runs).toBe(2);
    expect(job(server, id).state).toBe("done");
  });

  it("do not start early when woken, and a wake does not revive ended jobs", async () => {
    const log: string[] = [];
    const { timer, live } = fakeTimer();
    const server = await open([keyedModule(log)], { timer });
    const { jobs } = server.services;
    const delayed = jobs.start("t.keyed", { name: "late" }, { key: "k", after: 60_000 });
    const cancelled = jobs.start("t.keyed", { name: "x" }, { key: "j", after: 60_000 });
    jobs.cancel(cancelled);
    await ticks();

    jobs.wake("t.keyed", "k");
    jobs.wake("t.keyed", "j");
    await ticks();

    expect(log).toEqual([]);
    expect(live()).toHaveLength(1);
    expect(job(server, delayed).state).toBe("running");
    expect(job(server, cancelled).state).toBe("cancelled");
  });

  it("let a cancelled job's step finish before the next job of the key starts", async () => {
    const log: string[] = [];
    const gates = { a: gate() };
    const server = await open([keyedModule(log, gates)]);
    const { jobs } = server.services;
    const a = jobs.start("t.keyed", { name: "a" }, { key: "k" });
    jobs.start("t.keyed", { name: "b" }, { key: "k" });
    await ticks();
    jobs.cancel(a);
    await ticks();
    expect(log).toEqual(["a"]);

    gates.a.open();
    await ticks();

    expect(log).toEqual(["a", "b"]);
    expect(effects(server)).toEqual(["b"]);
    expect(job(server, a)).toMatchObject({ state: "cancelled", attempts: 0 });
  });
});

describe("cancel", () => {
  it("keeps a cancelled job cancelled when its held step then fails", async () => {
    const gates = { a: gate() };
    const server = await open([keyedModule([], gates)]);
    const id = server.services.jobs.start("t.keyed", { name: "a" });
    await ticks();
    server.services.jobs.cancel(id);

    gates.a.fail(new Error("late failure"));
    await ticks();

    expect(job(server, id)).toMatchObject({ state: "cancelled", attempts: 0, error: null });
  });
});

describe("start", () => {
  it("leaves no job and runs nothing when the caller's transaction rolls back", async () => {
    const log: string[] = [];
    const server = await open([keyedModule(log)]);

    expect(() =>
      server.store.transaction(() => {
        server.services.jobs.start("t.keyed", { name: "a" });
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    await ticks();

    expect(server.services.jobs.list()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("runs the job once the caller's transaction commits", async () => {
    const log: string[] = [];
    const server = await open([keyedModule(log)]);

    const id = server.store.transaction(() => server.services.jobs.start("t.keyed", { name: "a" }));
    await ticks();

    expect(log).toEqual(["a"]);
    expect(job(server, id).state).toBe("done");
  });

  it("throws for a kind nobody defined", async () => {
    const server = await open([]);

    expect(() => server.services.jobs.start("t.nope", {})).toThrow('Job kind "t.nope"');
  });
});

describe("define", () => {
  const steps = [{ name: "only", run: async () => ({}) }];

  it("rejects a kind outside the module's id", async () => {
    await expect(
      open([testModule((host) => host.jobs.define("other.kind", steps))]),
    ).rejects.toThrow('Job kind "other.kind" must start with "t."');
  });

  it("rejects a kind defined twice", async () => {
    await expect(
      open([
        testModule((host) => {
          host.jobs.define("t.kind", steps);
          host.jobs.define("t.kind", steps);
        }),
      ]),
    ).rejects.toThrow('Job kind "t.kind" is already defined');
  });
});

describe("the job API", () => {
  it("lists jobs that have not ended, or the states asked for", async () => {
    const server = await open([keyedModule([], { w: gate() })]);
    const done = server.services.jobs.start("t.keyed", { name: "d" });
    const running = server.services.jobs.start("t.keyed", { name: "w" });
    await ticks();

    const active = (await (await server.request("GET", "/api/jobs")).json()) as JobList;
    expect(active.jobs.map((entry) => entry.id)).toEqual([running]);
    const ended = (await (await server.request("GET", "/api/jobs?state=done")).json()) as JobList;
    expect(ended.jobs.map((entry) => entry.id)).toEqual([done]);
    expect((await server.request("GET", "/api/jobs?state=bogus")).status).toBe(400);
  });

  it("answers 404 for an unknown job and 409 for a job in the wrong state", async () => {
    const server = await open([keyedModule([])]);
    const id = server.services.jobs.start("t.keyed", { name: "d" });
    await ticks();

    const missing = await server.request("POST", "/api/jobs/nope/retry");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "job_not_found" } });
    const retry = await server.request("POST", `/api/jobs/${id}/retry`);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "job_not_retryable" } });
    const cancel = await server.request("POST", `/api/jobs/${id}/cancel`);
    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toMatchObject({ error: { code: "job_not_cancellable" } });
  });

  it("cancels a job that is waiting for its time", async () => {
    const { timer, live } = fakeTimer();
    const server = await open([keyedModule([])], { timer });
    const id = server.services.jobs.start("t.keyed", { name: "late" }, { after: 60_000 });
    await ticks();
    expect(live()).toHaveLength(1);

    const response = await server.request("POST", `/api/jobs/${id}/cancel`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, state: "cancelled" });
    expect(live()).toHaveLength(0);
  });
});

describe("changes and pruning", () => {
  it("tells listeners about each change and prunes ended jobs", async () => {
    const server = await open([keyedModule([])]);
    const seen: string[] = [];
    server.services.jobs.onChange((changed) => seen.push(`${changed.state}:${changed.step}`));
    const id = server.services.jobs.start("t.keyed", { name: "a" });
    await ticks();

    expect(seen).toEqual(["done:only"]);
    const doneAt = job(server, id).updatedAt;
    expect(server.services.jobs.prune(doneAt)).toBe(0);
    expect(server.services.jobs.prune(doneAt + 1)).toBe(1);
    expect(server.services.jobs.list()).toEqual([]);
  });
});

describe("the job schema", () => {
  it("matches the module API's JobView both ways", () => {
    expectTypeOf<JobView>().toEqualTypeOf<Job>();
  });
});
