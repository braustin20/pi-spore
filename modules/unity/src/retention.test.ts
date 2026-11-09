import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { agentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUnityModule } from "./server.js";

const DAY = 86_400_000;
const START = 1_700_000_000_000;
// The test clock ticks once per call, so a restart time is a little past a whole number of days.
const SLACK = 10_000;

let home: string;
let scratch: string;
let servers: TestServer[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-unity-retention-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-unity-retention-repos-")));
  servers = [];
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retention: { days: 30 } }));
});
afterEach(async () => {
  for (const server of servers) server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function start(startAt: number, firstId = 0): Promise<TestServer> {
  const server = await createTestServer(
    [
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      artifactsModule,
      agentsModule,
      actionsModule,
      attentionModule,
      createUnityModule({ processes: async () => [] }),
    ],
    { home, startAt, firstId },
  );
  servers.push(server);
  return server;
}

const stop = async (): Promise<void> => {
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

const leases = (server: TestServer, workspaceId: string): number =>
  server.store.all("SELECT 1 FROM unity_leases WHERE workspace_id = ?", workspaceId).length;

/** An archived workspace that holds a lease, then a restart `days` later. */
async function archivedThenRestarted(days: number) {
  const first = await start(START);
  const workspaceId = await makeWorkspace(first, "editor");
  first.store.run(
    `INSERT INTO unity_leases (project_id, path, workspace_id, owner, opened_at)
     VALUES ('project-x', '/tmp/editor', ?, 'pi-spore', ?)`,
    workspaceId,
    START,
  );
  await archive(first, workspaceId);
  await stop();
  return { server: await start(START + days * DAY + SLACK, 1000), workspaceId };
}

describe("unity retention", () => {
  it("deletes the lease of an archived workspace past the limit", async () => {
    const { server, workspaceId } = await archivedThenRestarted(31);
    expect(leases(server, workspaceId)).toBe(0);
  });

  it("keeps the lease of an archived workspace inside the limit", async () => {
    const { server, workspaceId } = await archivedThenRestarted(29);
    expect(leases(server, workspaceId)).toBe(1);
  });
});
