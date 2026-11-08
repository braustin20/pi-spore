import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGithubPrModule, type PrTimer } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

const timer: PrTimer = (run, ms) => {
  const entry = { run, ms, cancelled: false };
  timers.push(entry);
  return () => {
    entry.cancelled = true;
  };
};

const DAY = 86_400_000;
const START = 1_700_000_000_000;
// The test clock ticks once per call, so a restart time is a little past a whole number of days.
const SLACK = 10_000;

let home: string;
let scratch: string;
let servers: TestServer[];
/** Polls the module scheduled. */
let timers: { run: () => Promise<void>; ms: number; cancelled: boolean }[];
let agentModules: ReturnType<typeof createAgentsModule>[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-github-pr-retention-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-github-pr-retention-repos-")));
  servers = [];
  timers = [];
  agentModules = [];
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retention: { days: 30 } }));
});
afterEach(async () => {
  for (const agents of agentModules) await agents.manager().stopAll();
  for (const server of servers) server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function start(startAt: number, firstId = 0): Promise<TestServer> {
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
  });
  agentModules.push(agents);
  const server = await createTestServer(
    [
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      agents,
      attentionModule,
      kanbanModule,
      createGithubPrModule({ gh: { command: process.execPath, args: ["unused"] }, timer }),
    ],
    { home, startAt, firstId },
  );
  servers.push(server);
  return server;
}

const stop = async (): Promise<void> => {
  await agentModules.pop()?.manager().stopAll();
  servers.pop()?.close();
};

async function ok<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function makeWorkspace(server: TestServer, name: string): Promise<string> {
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
  return workspace.id;
}

const archive = async (server: TestServer, id: string) =>
  ok(await server.request("POST", `/api/workspaces/${id}/archive`, {}));

const TABLES = ["github_pr_prs", "github_pr_sent", "github_pr_tries"];

const rows = (server: TestServer, workspaceId: string): number[] =>
  TABLES.map(
    (table) =>
      server.store.all(`SELECT 1 FROM ${table} WHERE workspace_id = ?`, workspaceId).length,
  );

/** An archived workspace with a watched PR, a sent item, and a try, then a restart `days` later. */
async function archivedThenRestarted(days: number) {
  const first = await start(START);
  const workspaceId = await makeWorkspace(first, "pr");
  first.store.run(
    `INSERT INTO github_pr_prs (workspace_id, number, url, view, watch_state, tries, interval_ms, created_at)
     VALUES (?, 1, 'https://example.invalid/pr/1', '{}', 'watching', 0, 60000, ?)`,
    workspaceId,
    START,
  );
  first.store.run(
    "INSERT INTO github_pr_sent (workspace_id, item) VALUES (?, 'comment-1')",
    workspaceId,
  );
  first.store.run(
    "INSERT INTO github_pr_tries (id, workspace_id, at, head_id, summary) VALUES ('try-1', ?, ?, 'abc', 'fixed')",
    workspaceId,
    START,
  );
  await archive(first, workspaceId);
  await stop();
  timers = [];
  return { server: await start(START + days * DAY + SLACK, 1000), workspaceId };
}

describe("github-pr retention", () => {
  it("deletes the PR records of an archived workspace past the limit and cancels its poll", async () => {
    const { server, workspaceId } = await archivedThenRestarted(31);

    expect(rows(server, workspaceId)).toEqual([0, 0, 0]);
    // The restart scheduled the watch, and the sweep cancelled it.
    expect(timers).toHaveLength(1);
    expect(timers.every((entry) => entry.cancelled)).toBe(true);
  });

  it("keeps the PR records of an archived workspace inside the limit", async () => {
    const { server, workspaceId } = await archivedThenRestarted(29);

    expect(rows(server, workspaceId)).toEqual([1, 1, 1]);
    expect(timers.some((entry) => !entry.cancelled)).toBe(true);
  });
});
