import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kanbanModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

const DAY = 86_400_000;
const START = 1_700_000_000_000;
// The test clock ticks once per call, so a restart time is a little past a whole number of days.
const SLACK = 10_000;

let home: string;
let scratch: string;
let servers: TestServer[];
let agentModules: ReturnType<typeof createAgentsModule>[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-kanban-retention-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-kanban-retention-repos-")));
  servers = [];
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
      actionsModule,
      artifactsModule,
      pipelinesModule,
      runsModule,
      kanbanModule,
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

async function makeProject(server: TestServer, name: string): Promise<string> {
  const folder = join(scratch, name);
  mkdirSync(folder);
  const { project } = await ok<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  return project.id;
}

async function makeWorkspace(server: TestServer, projectId: string, name: string) {
  const { workspace } = await ok<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId,
      name,
      isolation: "in-place",
    }),
    201,
  );
  return workspace.id;
}

/** A card linked to `workspaceId`, blocked by that same workspace. */
async function makeCard(server: TestServer, title: string, workspaceId: string, blocker: string) {
  const { card } = await ok<{ card: { id: string } }>(
    await server.request("POST", "/api/kanban/cards", {
      title,
      blockedBy: [{ kind: "workspace", id: blocker }],
    }),
    201,
  );
  server.store.run("UPDATE kanban_cards SET workspace_id = ? WHERE id = ?", workspaceId, card.id);
  return card.id;
}

const cardOf = async (server: TestServer, id: string) =>
  (
    await ok<{ card: { workspaceId?: string; archivedAt?: number; blockedBy: unknown[] } }>(
      await server.request("GET", `/api/kanban/cards/${id}`),
    )
  ).card;

const links = (server: TestServer, cardId: string): number =>
  server.store.all("SELECT 1 FROM kanban_links WHERE card_id = ?", cardId).length;

describe("kanban retention", () => {
  it("keeps the cards of a deleted workspace, archived and unlinked", async () => {
    const first = await start(START);
    const projectId = await makeProject(first, "game");
    const oldWorkspace = await makeWorkspace(first, projectId, "old");
    const freshWorkspace = await makeWorkspace(first, projectId, "fresh");
    const oldCard = await makeCard(first, "Old work", oldWorkspace, oldWorkspace);
    const freshCard = await makeCard(first, "Fresh work", freshWorkspace, freshWorkspace);
    await ok(await first.request("POST", `/api/workspaces/${oldWorkspace}/archive`, {}));
    await stop();
    // Archived 20 days later, it is still inside the 30-day limit when server 3 starts.
    const second = await start(START + 20 * DAY, 1000);
    await ok(await second.request("POST", `/api/workspaces/${freshWorkspace}/archive`, {}));
    await stop();

    const third = await start(START + 31 * DAY + SLACK, 2000);
    const old = await cardOf(third, oldCard);
    expect(old.workspaceId).toBeUndefined();
    expect(old.archivedAt).toBeDefined();
    expect(old.blockedBy).toEqual([]);
    expect(links(third, oldCard)).toBe(0);

    const fresh = await cardOf(third, freshCard);
    expect(fresh.workspaceId).toBe(freshWorkspace);
    expect(fresh.archivedAt).toBeUndefined();
    expect(links(third, freshCard)).toBe(1);
  });
});
