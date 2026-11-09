import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentsKey, createAgentsModule } from "@pi-spore/mod-agents/server";
import { type Approvals, ApprovalsKey, attentionModule } from "@pi-spore/mod-attention/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import Type from "typebox";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type CliDeps, run } from "./cli.js";

const FAKE_PI = fileURLToPath(
  new URL("../../../modules/agents/test-fixtures/fake-pi.mjs", import.meta.url),
);

let server: TestServer;
let scratch: string;
let agents: ReturnType<typeof createAgentsModule>;
let approvals: Approvals;
let dialogOpened: Promise<void>;

/** A module with a gate, as the model upgrade or "close Unity?" modules register theirs (ADR 0100). */
const gateModule: ServerModule = {
  id: "gate",
  requires: ["attention", "agents"],
  core: false,
  setup(host) {
    // The public hook says when the fake agent has a dialog open, so the test needs no polling.
    dialogOpened = new Promise((resolve) => {
      host.use(AgentsKey).onChange((_agentId, change) => {
        if (change === "dialog") resolve();
      });
    });
    approvals = host.use(ApprovalsKey);
    approvals.register({
      kind: "test-gate",
      subject: Type.Object({ model: Type.String() }),
      approve: async () => "ok",
    });
  },
};

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-cli-inbox-")));
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
    gateModule,
  ]);
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function json<T>(response: Response, status = 200): Promise<T> {
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

/** The CLI, with its requests sent to the test server's app. */
function cli() {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    fetch: (async (input: URL, init?: RequestInit) =>
      await server.request(
        init?.method ?? "GET",
        `${input.pathname}${input.search}`,
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      )) as typeof fetch,
    env: {},
    out: (line) => out.push(line),
    write: () => {},
    err: (line) => err.push(line),
    readToken: () => "test",
    resolvePath: (path) => path,
    newKey: () => "key",
    now: server.services.now,
  };
  return { deps, out, err };
}

it("lists a waiting dialog and an open approval from the running server, and shows them", async () => {
  const { agentId, workspaceId } = await makeAgent("gates");
  const approval = approvals.file(
    { agentId, workspaceId },
    { kind: "test-gate", title: "Use big", reason: "Hard task", subject: { model: "big" } },
  );
  await server.request("POST", `/api/agents/${agentId}/prompt`, { message: "/dialog" });
  const { deps, out, err } = cli();
  const link = `#/workspaces/${workspaceId}/chats/${agentId}`;

  await dialogOpened;
  expect(await run(["inbox", "list"], deps)).toBe(0);
  const lines = [...out];

  expect(lines.map((line) => line.split("  ").slice(0, 2)).sort()).toEqual([
    [`approval:${approval.id}`, "approval"],
    [`dialog:${agentId}:dlg-1`, "dialog"],
    // The agent is still in its turn, waiting on the dialog.
    [`running:${agentId}`, "running"],
  ]);
  expect(lines.every((line) => line.endsWith(`  ${link}`))).toBe(true);

  out.length = 0;
  expect(await run(["inbox", "show", `approval:${approval.id}`], deps)).toBe(0);
  expect(out).toContain("reason: Hard task");
  expect(out).toContain(`link: ${link}`);
  out.length = 0;
  expect(await run(["inbox", "show", `dialog:${agentId}:dlg-1`], deps)).toBe(0);
  expect(out).toContain("title: Proceed?");
  expect(err).toEqual([]);
});
