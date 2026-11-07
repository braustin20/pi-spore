import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type { Inbox, InboxEvent } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attentionModule, INBOX_TOPIC } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let server: TestServer;
let scratch: string;
let agents: ReturnType<typeof createAgentsModule>;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-attention-")));
  agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 5_000,
  });
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    vcsFolderModule,
    workspacesModule,
    agents,
    attentionModule,
  ]);
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function makeAgent(name: string) {
  const folder = join(scratch, name);
  mkdirSync(folder);
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await json<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name,
      isolation: "in-place",
    }),
    201,
  );
  const { agent } = await json<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
    201,
  );
  return { agentId: agent.id, workspaceId: workspace.id };
}

const inbox = async () => json<Inbox>(await server.request("GET", "/api/attention/inbox"));
const kinds = async () =>
  (await inbox()).items.map((item) => `${item.kind} ${item.workspace.name}`);
const prompt = (agentId: string, message: string) =>
  server.request("POST", `/api/agents/${agentId}/prompt`, { message });

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Home inbox", () => {
  it("is empty with nothing to do", async () => {
    await makeAgent("quiet");
    expect(await inbox()).toEqual({ items: [], running: [] });
  });

  it("shows an open extension dialog until it is answered", async () => {
    const { agentId } = await makeAgent("dialogs");
    await json(await prompt(agentId, "/dialog"));
    await until(async () => (await kinds()).includes("dialog dialogs"));
    expect((await inbox()).items[0]).toMatchObject({
      kind: "dialog",
      agentId,
      dialog: { id: "dlg-1", method: "confirm", title: "Proceed?" },
    });
    expect((await inbox()).running).toMatchObject([{ agentId, status: "busy" }]);

    await json(
      await server.request("POST", `/api/agents/${agentId}/dialog`, {
        dialogId: "dlg-1",
        confirmed: true,
      }),
    );
    await until(async () => !(await kinds()).includes("dialog dialogs"));
  });

  it("shows a failed agent with its error", async () => {
    const { agentId } = await makeAgent("broken");
    await prompt(agentId, "crash");
    await until(async () => (await kinds()).includes("failed broken"));
    const item = (await inbox()).items[0] as { error: string };
    expect(item.error).toContain("boom: the fake agent crashed");
  });

  it("shows a finished agent newest first, and drops it when seen or messaged", async () => {
    const first = await makeAgent("first");
    const second = await makeAgent("second");
    await json(await prompt(first.agentId, "one"));
    await until(async () => (await kinds()).includes("finished first"));
    await json(await prompt(second.agentId, "two"));
    await until(async () => (await kinds()).length === 2);
    expect(await kinds()).toEqual(["finished second", "finished first"]);

    await json(await server.request("POST", `/api/agents/${second.agentId}/seen`));
    expect(await kinds()).toEqual(["finished first"]);
    await json(await prompt(second.agentId, "three"));
    await until(async () => (await kinds()).includes("finished second"));
    await json(await server.request("POST", `/api/agents/${second.agentId}/seen`));
    // Opening the chat counts as seeing it.
    await server.events.snapshot(`agent:${first.agentId}`);
    expect(await kinds()).toEqual([]);

    // The reply to a new message sets it again, and it is stored.
    await json(await prompt(first.agentId, "again"));
    await until(async () => (await kinds()).includes("finished first"));
    expect(
      server.store.get<{ waiting_since: number | null }>(
        "SELECT waiting_since FROM agents_agents WHERE id = ?",
        first.agentId,
      )?.waiting_since,
    ).toBeTypeOf("number");
  });

  it("drops a finished agent as soon as the user sends it a message", async () => {
    const { agentId } = await makeAgent("busy");
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished busy"));
    await json(await prompt(agentId, "slow:300"));
    expect(await kinds()).toEqual([]);
  });

  it("does not show an aborted run as finished", async () => {
    const { agentId } = await makeAgent("aborted");
    await json(await prompt(agentId, "slow:400"));
    await until(async () => (await inbox()).running.length === 1);
    await json(await server.request("POST", `/api/agents/${agentId}/abort`));
    await until(async () => (await inbox()).running.length === 0);
    expect(await kinds()).toEqual([]);
  });

  it("sends the whole inbox to subscribers on subscribe and after changes", async () => {
    const { agentId } = await makeAgent("live");
    const [first] = (await server.events.snapshot(INBOX_TOPIC)) as InboxEvent[];
    expect(first).toEqual({ type: "inbox", inbox: { items: [], running: [] } });

    await json(await prompt(agentId, "hi"));
    await until(async () =>
      (server.events.eventsOf(INBOX_TOPIC) as InboxEvent[]).some(
        (event) => event.inbox.items[0]?.kind === "finished",
      ),
    );
  });

  it("names the chat of each item, and drops what an older worker chat left behind", async () => {
    const { agentId, workspaceId } = await makeAgent("switch");
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished switch"));
    expect((await inbox()).items[0]).toMatchObject({
      chat: { id: agentId, kind: "worker", active: true, title: "one" },
    });

    await json(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
      201,
    );
    await until(async () => (await kinds()).length === 0);
  });

  it("answers 404 for an unknown question", async () => {
    const response = await server.request("POST", "/api/attention/questions/nope/answer", {
      answer: "x",
    });
    expect(response.status).toBe(404);
  });
});
