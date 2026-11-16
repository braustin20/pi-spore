import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import {
  createTestServer,
  silentLog,
  TEST_TOKEN,
  type TestServer,
} from "@pi-spore/server-core/testing";
import type { HomeNotice, InboxEvent, PushPayload } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttentionModule,
  type HomeItems,
  HomeItemsKey,
  INBOX_TOPIC,
  type PushSender,
  type Questions,
  QuestionsKey,
} from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

type PushCall = {
  target: Parameters<PushSender>[0];
  payload: string;
  vapid: Parameters<PushSender>[2];
};

let home: string;
let scratch: string;
let servers: TestServer[];
let agentModules: ReturnType<typeof createAgentsModule>[];
let server: TestServer;
let calls: PushCall[];
/** The push service's answer per endpoint, or what the send throws; 201 when not set. */
let statuses: Map<string, number | Error>;
let questions: Questions;
let homeItems: HomeItems;
let notices: HomeNotice[];
/** The test source answers its next read with this, once, so a test can hold that read. */
let held: Promise<HomeNotice[]> | undefined;
let sourceReads: number;

const sendPush: PushSender = async (target, payload, vapid) => {
  calls.push({ target, payload, vapid });
  const answer = statuses.get(target.endpoint) ?? 201;
  if (answer instanceof Error) throw answer;
  return answer;
};

/** Files questions and adds Home notices, as the bridge and other modules do. */
const testModule: ServerModule = {
  id: "asker",
  requires: ["attention"],
  core: false,
  setup(host) {
    questions = host.use(QuestionsKey);
    homeItems = host.use(HomeItemsKey);
    homeItems.register("test-source", () => {
      sourceReads++;
      const answer = held ?? notices;
      held = undefined;
      return answer;
    });
  },
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-push-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-push-repos-")));
  servers = [];
  agentModules = [];
  calls = [];
  statuses = new Map();
  notices = [];
  held = undefined;
  sourceReads = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const agents of agentModules) await agents.manager().stopAll();
  for (const each of servers) each.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function start(firstId = 0): Promise<TestServer> {
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
  });
  agentModules.push(agents);
  server = await createTestServer(
    [
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      agents,
      createAttentionModule({ sendPush }),
      testModule,
    ],
    { home, firstId },
  );
  servers.push(server);
  return server;
}

const stop = async (): Promise<void> => {
  await agentModules.pop()?.manager().stopAll();
  servers.pop()?.close();
};

async function ok<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function makeAgent(name: string) {
  const folder = join(scratch, name);
  mkdirSync(folder);
  const { project } = await ok<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await ok<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name,
      isolation: "in-place",
    }),
    201,
  );
  const { agent } = await ok<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
    201,
  );
  return { agentId: agent.id, workspaceId: workspace.id };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** True once a published inbox has an item with this key prefix and id. */
const published = (match: (item: InboxEvent["inbox"]["items"][number]) => boolean) =>
  (server.events.eventsOf(INBOX_TOPIC) as InboxEvent[]).some((event) =>
    event.inbox.items.some(match),
  );

/** Files a question and waits until Home has published it; the pushes for it start in that same step. */
async function ask(caller: { agentId: string; workspaceId: string }, text = "Ship it?") {
  const question = questions.file(caller, { question: text });
  await until(() =>
    published((item) => item.kind === "question" && item.question.id === question.id),
  );
  // A push's answer is handled after its send resolves.
  await new Promise((resolve) => setImmediate(resolve));
  return question;
}

const subscribe = async (endpoint: string, keys = { p256dh: "p-key", auth: "a-key" }) =>
  ok<{ id: string }>(
    await server.request(
      "POST",
      "/api/attention/push/subscriptions",
      { endpoint, keys },
      { "user-agent": "Test phone" },
    ),
  );

/** Where pushes went. Tests compare these, not whole calls, so a failure never prints the VAPID keys. */
const endpoints = () => calls.map((call) => call.target.endpoint);

const payloadOf = (call: PushCall | undefined) =>
  JSON.parse(call?.payload ?? "null") as PushPayload;

describe("phone push", () => {
  it("sends a new question to every subscription, with only the payload fields", async () => {
    await start();
    const { publicKey } = await ok<{ publicKey: string }>(
      await server.request("GET", "/api/attention/push/key"),
    );
    await subscribe("https://push.example/one");
    await subscribe("https://push.example/two");
    const caller = await makeAgent("asker");
    const text = `Which way? ${"x".repeat(300)}`;
    const question = await ask(caller, text);

    expect(endpoints().sort()).toEqual(["https://push.example/one", "https://push.example/two"]);
    const payload = payloadOf(calls[0]);
    expect(payload).toEqual({
      title: "Question from asker (asker)",
      body: text.slice(0, 200),
      href: `#/workspaces/${caller.workspaceId}/chats/${caller.agentId}`,
      tag: `question:${question.id}`,
      badge: 1,
    });
    expect(calls[0]?.payload).not.toContain(TEST_TOKEN);
    expect(calls[0]?.target.keys).toEqual({ p256dh: "p-key", auth: "a-key" });
    expect(calls[0]?.vapid).toMatchObject({ subject: "https://127.0.0.1:7420", publicKey });
  });

  it("sends nothing at start for an open question, and pushes the first new one after", async () => {
    await start();
    await subscribe("https://push.example/one");
    const caller = await makeAgent("asker");
    await ask(caller, "Before the restart?");
    expect(endpoints()).toHaveLength(1);
    await stop();
    calls = [];

    await start(1_000);
    // The old question is still on Home after the restart.
    const inbox = await ok<{ items: unknown[] }>(
      await server.request("GET", "/api/attention/inbox"),
    );
    expect(inbox.items).toHaveLength(1);
    expect(endpoints()).toEqual([]);
    const question = await ask(caller, "After the restart?");
    expect(calls.map((call) => payloadOf(call).tag)).toEqual([`question:${question.id}`]);
  });

  it("deletes a subscription the push service says is gone, and keeps one that failed", async () => {
    await start();
    await subscribe("https://push.example/gone");
    const { id: failing } = await subscribe("https://push.example/failing");
    statuses.set("https://push.example/gone", 410);
    statuses.set("https://push.example/failing", 500);
    const warn = vi.spyOn(silentLog, "warn");
    const info = vi.spyOn(silentLog, "info");
    const caller = await makeAgent("asker");
    await ask(caller, "First?");
    expect(endpoints()).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("Push failed", { subscription: failing, status: 500 });
    const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
    expect(logged).not.toContain("push.example");
    expect(logged).not.toContain("p-key");

    calls = [];
    await ask(caller, "Second?");
    expect(endpoints()).toEqual(["https://push.example/failing"]);
  });

  it("logs a send that throws by its code, and still pushes to the others", async () => {
    await start();
    const { id } = await subscribe("https://push.example/down");
    await subscribe("https://push.example/up");
    // A failure in the network layer, as `https` throws it.
    statuses.set(
      "https://push.example/down",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const warn = vi.spyOn(silentLog, "warn");
    await ask(await makeAgent("asker"));
    expect(endpoints()).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("Push failed", { subscription: id, error: "ECONNREFUSED" });
  });

  it("keeps one row for the same endpoint, with its newest keys", async () => {
    await start();
    const first = await subscribe("https://push.example/one", { p256dh: "old", auth: "old" });
    const second = await subscribe("https://push.example/one", { p256dh: "new", auth: "new" });
    expect(second.id).toBe(first.id);
    await ask(await makeAgent("asker"));
    expect(calls.map((call) => call.target.keys)).toEqual([{ p256dh: "new", auth: "new" }]);
  });

  it("stops pushing to a removed subscription; removing an unknown one is fine", async () => {
    await start();
    await subscribe("https://push.example/one");
    await ok(
      await server.request("DELETE", "/api/attention/push/subscriptions", {
        endpoint: "https://push.example/one",
      }),
    );
    await ok(
      await server.request("DELETE", "/api/attention/push/subscriptions", {
        endpoint: "https://push.example/unknown",
      }),
    );
    await ask(await makeAgent("asker"));
    expect(endpoints()).toEqual([]);
  });

  it("refuses a subscription whose endpoint is not https", async () => {
    await start();
    await ok(
      await server.request("POST", "/api/attention/push/subscriptions", {
        endpoint: "http://push.example/one",
        keys: { p256dh: "p", auth: "a" },
      }),
      400,
    );
  });

  it("refuses an https endpoint that is not a whole URL", async () => {
    await start();
    for (const endpoint of ["https://", "https://bad host/path", "https:///path"])
      await ok(
        await server.request("POST", "/api/attention/push/subscriptions", {
          endpoint,
          keys: { p256dh: "p", auth: "a" },
        }),
        400,
      );
  });

  it("refuses an endpoint that a URL parser rejects", async () => {
    await start();
    for (const endpoint of ["https://push.example:99999/push", "https://256.256.256.256/push"])
      await ok(
        await server.request("POST", "/api/attention/push/subscriptions", {
          endpoint,
          keys: { p256dh: "p", auth: "a" },
        }),
        400,
      );
  });

  it("keeps what a newer build saw when the start build ends last", async () => {
    await start();
    await subscribe("https://push.example/one");
    const caller = await makeAgent("asker");
    await stop();

    // The start build reads the source last of its steps, so its chat items are already fixed when it waits here.
    let release: (notices: HomeNotice[]) => void = () => {};
    held = new Promise((resolve) => {
      release = resolve;
    });
    sourceReads = 0;
    const starting = start(1_000);
    await until(() => sourceReads === 1);
    // A newer build sees the question and publishes before the start build ends.
    questions.file(caller, { question: "While starting?" });
    await until(() => sourceReads === 2);
    await new Promise((resolve) => setImmediate(resolve));
    release([]);
    await starting;

    const before = server.events.eventsOf(INBOX_TOPIC).length;
    homeItems.changed();
    await until(() => server.events.eventsOf(INBOX_TOPIC).length > before);
    await new Promise((resolve) => setImmediate(resolve));
    expect(endpoints()).toEqual([]);
  });

  it("sends nothing while a desktop page has focus, and again once it expires or blurs", async () => {
    await start();
    await subscribe("https://push.example/one");
    const caller = await makeAgent("asker");
    const focus = async (focused: boolean) =>
      ok(await server.request("POST", "/api/attention/push/focus", { page: "desk-1", focused }));

    await focus(true);
    await ask(caller, "While focused?");
    expect(endpoints()).toEqual([]);

    server.advance(61_000);
    await ask(caller, "After the report expired?");
    expect(endpoints()).toHaveLength(1);

    await focus(true);
    await ask(caller, "Focused again?");
    expect(endpoints()).toHaveLength(1);
    await focus(false);
    await ask(caller, "After blur?");
    expect(endpoints()).toHaveLength(2);
  });

  it("sends nothing for a Home notice", async () => {
    await start();
    await subscribe("https://push.example/one");
    notices = [{ id: "card-1", at: 1, title: "Overdue: Ship it", href: "#/board" }];
    homeItems.changed();
    await until(() => published((item) => item.kind === "notice"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(endpoints()).toEqual([]);
  });

  it("makes the VAPID key file once, mode 0600, and reads the same key after a restart", async () => {
    await start();
    const first = await ok<{ publicKey: string }>(
      await server.request("GET", "/api/attention/push/key"),
    );
    expect(statSync(join(home, "vapid.json")).mode & 0o777).toBe(0o600);
    await stop();
    await start(1_000);
    const second = await ok<{ publicKey: string }>(
      await server.request("GET", "/api/attention/push/key"),
    );
    expect(first.publicKey.length).toBeGreaterThan(40);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it("refuses to start with a broken VAPID key file, and names it", async () => {
    writeFileSync(join(home, "vapid.json"), JSON.stringify({ publicKey: "x", privateKey: "x" }));
    await expect(start()).rejects.toThrow(
      `The VAPID keys in ${join(home, "vapid.json")} are broken; delete the file to make new ones`,
    );
  });
});
