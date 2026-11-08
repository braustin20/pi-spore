import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionsModule } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/action.mjs", import.meta.url));

const DAY = 86_400_000;
const START = 1_700_000_000_000;
// The test clock ticks once per call, so a restart time is a little past a whole number of days.
const SLACK = 10_000;

let home: string;
let scratch: string;
let servers: TestServer[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-actions-retention-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-actions-retention-repos-")));
  servers = [];
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retention: { days: 30 } }));
});
afterEach(() => {
  for (const server of servers) server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function start(startAt: number, firstId = 0): Promise<TestServer> {
  const server = await createTestServer(
    [projectsModule, vcsGitModule, vcsFolderModule, workspacesModule, actionsModule],
    { home, startAt, firstId },
  );
  servers.push(server);
  return server;
}

const stop = (): void => servers.pop()?.close();

async function ok<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function makeWorkspace(server: TestServer, name: string): Promise<string> {
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(
    join(folder, ".pi-spore", "config.toml"),
    `[actions.say]\nrun = ${JSON.stringify([process.execPath, FIXTURE, "say", "hi"])}\n`,
  );
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

/** Runs the `say` action to its end and returns the run id. */
async function runOnce(server: TestServer, workspaceId: string): Promise<string> {
  const { run } = await ok<{ run: { id: string } }>(
    await server.request("POST", `/api/actions/workspaces/${workspaceId}/runs`, {
      action: "say",
    }),
    201,
  );
  await ok(await server.request("GET", `/api/actions/runs/${run.id}?wait=10000`));
  return run.id;
}

const runRows = (server: TestServer, column: string, id: string): number =>
  server.store.all(`SELECT 1 FROM actions_runs WHERE ${column} = ?`, id).length;

const logFolder = (server: TestServer, workspaceId: string): string =>
  join(server.paths.logs, "actions", workspaceId);

async function archivedThenRestarted(days: number) {
  const first = await start(START);
  const workspaceId = await makeWorkspace(first, "gone");
  const runId = await runOnce(first, workspaceId);
  await ok(await first.request("POST", `/api/workspaces/${workspaceId}/archive`, {}));
  expect(existsSync(logFolder(first, workspaceId))).toBe(true);
  stop();
  const server = await start(START + days * DAY + SLACK, 1000);
  return { server, workspaceId, runId };
}

describe("action retention", () => {
  it("deletes the runs and the log folder of an archived workspace past the limit", async () => {
    const { server, workspaceId } = await archivedThenRestarted(31);

    expect(runRows(server, "workspace_id", workspaceId)).toBe(0);
    expect(existsSync(logFolder(server, workspaceId))).toBe(false);
  });

  it("keeps the runs and logs of an archived workspace inside the limit", async () => {
    const { server, workspaceId } = await archivedThenRestarted(29);

    expect(runRows(server, "workspace_id", workspaceId)).toBe(1);
    expect(existsSync(logFolder(server, workspaceId))).toBe(true);
  });

  it("deletes an old ended run of an active workspace and keeps a newer one", async () => {
    const first = await start(START);
    const workspaceId = await makeWorkspace(first, "busy");
    const oldRun = await runOnce(first, workspaceId);
    const oldLog = join(logFolder(first, workspaceId), `${oldRun}.log`);
    expect(existsSync(oldLog)).toBe(true);
    stop();

    const second = await start(START + 20 * DAY, 1000);
    const newRun = await runOnce(second, workspaceId);
    stop();

    const third = await start(START + 31 * DAY + SLACK, 2000);
    expect(runRows(third, "id", oldRun)).toBe(0);
    expect(existsSync(oldLog)).toBe(false);
    expect(runRows(third, "id", newRun)).toBe(1);
    expect(existsSync(join(logFolder(third, workspaceId), `${newRun}.log`))).toBe(true);
    expect((await third.request("GET", `/api/workspaces/${workspaceId}`)).status).toBe(200);
  });

  it("answers 404 log_not_found for a run whose log file is gone", async () => {
    const server = await start(START);
    const workspaceId = await makeWorkspace(server, "lost");
    const runId = await runOnce(server, workspaceId);
    rmSync(join(logFolder(server, workspaceId), `${runId}.log`));

    const response = await server.request("GET", `/api/actions/runs/${runId}/log`);
    const body = await ok<{ error: { code: string } }>(response, 404);
    expect(body.error.code).toBe("log_not_found");
  });
});
