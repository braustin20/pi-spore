import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Actions, ActionsKey, actionsModule } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/action.mjs", import.meta.url));

let home: string;
let scratch: string;
let servers: TestServer[];
let actions: Actions;

/** Another module that starts runs, as a pipeline gate would. */
const callerModule: ServerModule = {
  id: "caller",
  requires: ["actions"],
  core: false,
  setup(host) {
    actions = host.use(ActionsKey);
  },
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-actions-key-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-actions-key-repos-")));
  servers = [];
});
afterEach(() => {
  for (const server of servers) server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function start(firstId = 0): Promise<TestServer> {
  const server = await createTestServer(
    [projectsModule, vcsGitModule, vcsFolderModule, workspacesModule, actionsModule, callerModule],
    { home, firstId },
  );
  servers.push(server);
  return server;
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function makeWorkspace(server: TestServer, run: string[]): Promise<string> {
  const folder = join(scratch, "project");
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(
    join(folder, ".pi-spore", "config.toml"),
    `[actions.check]\nrun = ${JSON.stringify([process.execPath, FIXTURE, ...run])}\n`,
  );
  const { project } = await ok<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await ok<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "Work",
      isolation: "in-place",
    }),
    201,
  );
  return workspace.id;
}

const rowCount = (server: TestServer): number =>
  server.store.all("SELECT 1 FROM actions_runs").length;

describe("action run keys", () => {
  it("returns the run stored under a key and starts nothing more", async () => {
    const server = await start();
    const workspaceId = await makeWorkspace(server, ["say", "hi"]);

    const first = await actions.start(workspaceId, "check", "pipeline", { key: "gate-1" });
    const again = await actions.start(workspaceId, "check", "pipeline", { key: "gate-1" });

    expect(again.id).toBe(first.id);
    expect(rowCount(server)).toBe(1);
    // Also after the run has ended.
    await actions.wait(first.id);
    expect((await actions.start(workspaceId, "check", "pipeline", { key: "gate-1" })).id).toBe(
      first.id,
    );
    expect(rowCount(server)).toBe(1);
  });

  it("starts a new run for a different key, and for no key", async () => {
    const server = await start();
    const workspaceId = await makeWorkspace(server, ["say", "hi"]);

    const first = await actions.start(workspaceId, "check", "pipeline", { key: "gate-1" });
    const other = await actions.start(workspaceId, "check", "pipeline", { key: "gate-2" });
    const plain = await actions.start(workspaceId, "check", "user");
    const plainAgain = await actions.start(workspaceId, "check", "user");

    expect(new Set([first.id, other.id, plain.id, plainAgain.id]).size).toBe(4);
    await Promise.all([first, other, plain, plainAgain].map((run) => actions.wait(run.id)));
    expect(rowCount(server)).toBe(4);
  });

  it("returns the interrupted run for a key after a restart", async () => {
    const first = await start();
    const workspaceId = await makeWorkspace(first, ["hang"]);
    const run = await actions.start(workspaceId, "check", "pipeline", { key: "gate-1" });
    expect(run.status).toBe("running");
    // A real stop kills the process and leaves the row as it was. Here the process ends first, so the closed store
    // is not written to later, and the row is put back.
    actions.cancel(run.id);
    await actions.wait(run.id);
    first.store.run(
      "UPDATE actions_runs SET status = 'running', ended_at = NULL WHERE id = ?",
      run.id,
    );
    servers.pop()?.close();

    const second = await start(1000);
    const again = await actions.start(workspaceId, "check", "pipeline", { key: "gate-1" });

    expect(again).toMatchObject({ id: run.id, status: "interrupted" });
    expect(rowCount(second)).toBe(1);
  });

  it("records the pipeline trigger", async () => {
    const server = await start();
    const workspaceId = await makeWorkspace(server, ["say", "hi"]);

    const run = await actions.start(workspaceId, "check", "pipeline", { key: "gate-1" });

    expect(run.trigger).toBe("pipeline");
    await actions.wait(run.id);
    expect(actions.get(run.id).trigger).toBe("pipeline");
  });
});
