import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import type { ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import {
  CreateWorkspaceResponse,
  Project,
  parse,
  type Workspace,
  WorkspaceList,
} from "@pi-spore/shared";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacesKey, workspacesModule } from "./server.js";

const DAY = 86_400_000;
const START = 1_700_000_000_000;
// The test clock ticks once per call, so the restart time is a little past a whole number of days.
const SLACK = 10_000;

const BASE = [projectsModule, vcsGitModule, vcsFolderModule, workspacesModule];

let home: string;
let scratch: string;
let servers: TestServer[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-retention-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-retention-repos-")));
  servers = [];
});
afterEach(() => {
  for (const server of servers) server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function start(
  modules: readonly ServerModule[],
  options: { startAt: number; firstId?: number },
): Promise<TestServer> {
  const server = await createTestServer(modules, { home, ...options });
  servers.push(server);
  return server;
}

/** The first server of a test: one in-place workspace in a plain folder project. */
async function seed(): Promise<{ server: TestServer; workspace: Workspace; folder: string }> {
  const server = await start(BASE, { startAt: START });
  const folder = join(scratch, "notes");
  mkdirSync(folder);
  writeFileSync(join(folder, "keep.txt"), "mine");
  const project = parse(
    Type.Object({ project: Project }),
    await (await server.request("POST", "/api/projects", { path: folder })).json(),
    "add project",
  ).project;
  const created = parse(
    CreateWorkspaceResponse,
    await (
      await server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "Old",
        isolation: "in-place",
      })
    ).json(),
    "create workspace",
  );
  return { server, workspace: created.workspace, folder };
}

const archive = (server: TestServer, id: string) =>
  server.request("POST", `/api/workspaces/${id}/archive`, {});

interface Calls {
  retention: number[];
  deleted: string[];
}

/** Records what the sweep hands to listeners. With `failing`, a delete listener throws before the recording one. */
function recorder(calls: Calls, options: { failing?: boolean } = {}): ServerModule {
  return {
    id: "recorder",
    requires: ["projects", "workspaces"],
    core: false,
    setup(host) {
      const workspaces = host.use(WorkspacesKey);
      workspaces.onRetention(async (cutoff) => {
        calls.retention.push(cutoff);
      });
      if (options.failing) {
        workspaces.beforeDeleteWorkspace(async () => {
          throw new Error("disk is busy");
        });
      }
      workspaces.beforeDeleteWorkspace(async (workspace) => {
        calls.deleted.push(workspace.id);
      });
    },
  };
}

async function status(server: TestServer, id: string): Promise<number> {
  return (await server.request("GET", `/api/workspaces/${id}`)).status;
}

async function listedIds(server: TestServer): Promise<string[]> {
  const list = parse(
    WorkspaceList,
    await (await server.request("GET", "/api/workspaces")).json(),
    "list",
  );
  return list.workspaces.map((workspace) => workspace.id);
}

function setDays(days: unknown): void {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retention: { days } }));
}

async function archivedThenRestarted(
  daysOld: number,
  options: { failing?: boolean; settleSettings?: () => void } = {},
): Promise<{ server: TestServer; workspace: Workspace; calls: Calls; folder: string }> {
  const first = await seed();
  // A bad settings file stops workspace creation, so a test that needs one writes it after the seed.
  options.settleSettings?.();
  expect((await archive(first.server, first.workspace.id)).status).toBe(200);
  first.server.close();
  servers.pop();
  const calls: Calls = { retention: [], deleted: [] };
  const server = await start([...BASE, recorder(calls, options)], {
    startAt: START + daysOld * DAY + SLACK,
    firstId: 1000,
  });
  return { server, workspace: first.workspace, calls, folder: first.folder };
}

describe("retention sweep", () => {
  it("deletes a workspace archived longer ago than retention.days", async () => {
    setDays(30);
    const { server, workspace, calls } = await archivedThenRestarted(31);

    expect(await status(server, workspace.id)).toBe(404);
    expect(await listedIds(server)).not.toContain(workspace.id);
    expect(calls.deleted).toEqual([workspace.id]);
    expect(calls.retention).toHaveLength(1);
    expect(calls.retention[0]).toBeGreaterThan(START + DAY);
    expect(calls.retention[0]).toBeLessThan(START + DAY + 2 * SLACK);
    expect(server.events.eventsOf("workspaces:list")).toContainEqual({
      type: "removed",
      id: workspace.id,
    });
  });

  it("keeps a workspace archived more recently than retention.days", async () => {
    setDays(30);
    const { server, workspace, calls } = await archivedThenRestarted(29);

    expect(await status(server, workspace.id)).toBe(200);
    expect(calls.deleted).toEqual([]);
  });

  it("keeps a parked workspace older than retention.days", async () => {
    setDays(30);
    const first = await seed();
    expect(
      (await first.server.request("POST", `/api/workspaces/${first.workspace.id}/park`)).status,
    ).toBe(200);
    first.server.close();
    servers.pop();
    const calls: Calls = { retention: [], deleted: [] };
    const server = await start([...BASE, recorder(calls)], {
      startAt: START + 90 * DAY,
      firstId: 1000,
    });

    expect(await status(server, first.workspace.id)).toBe(200);
    expect(calls.deleted).toEqual([]);
  });

  it("does nothing when retention.days is 0", async () => {
    setDays(0);
    const { server, workspace, calls } = await archivedThenRestarted(400);

    expect(await status(server, workspace.id)).toBe(200);
    expect(calls).toEqual({ retention: [], deleted: [] });
  });

  it("does nothing when retention.days is not valid", async () => {
    const { server, workspace, calls } = await archivedThenRestarted(400, {
      settleSettings: () => setDays(-1),
    });

    expect(await status(server, workspace.id)).toBe(200);
    expect(calls).toEqual({ retention: [], deleted: [] });
  });

  it("keeps the row when a delete listener throws, and still runs the others", async () => {
    setDays(30);
    const { server, workspace, calls } = await archivedThenRestarted(31, { failing: true });

    expect(await status(server, workspace.id)).toBe(200);
    expect(calls.deleted).toEqual([workspace.id]);
  });

  it("deletes stored responses older than the cutoff and keeps newer ones", async () => {
    setDays(30);
    const first = await seed();
    const old = await first.server.request(
      "POST",
      "/api/projects",
      { path: scratch },
      {
        "idempotency-key": "old-key",
      },
    );
    expect(old.status).toBeLessThan(500);
    const recent = START + 10 * DAY;
    first.server.store.run(
      "INSERT INTO core_idempotency (key, request, status, body, created_at) VALUES (?, ?, ?, ?, ?)",
      "new-key",
      "POST /x",
      200,
      "{}",
      recent,
    );
    first.server.close();
    servers.pop();

    const server = await start(BASE, { startAt: START + 31 * DAY, firstId: 1000 });

    const keys = server.store
      .all<{ key: string }>("SELECT key FROM core_idempotency")
      .map((row) => row.key);
    expect(keys).toEqual(["new-key"]);
  });

  it("deletes ended jobs older than the cutoff and keeps newer and running ones", async () => {
    setDays(30);
    const first = await seed();
    const insert = (id: string, state: string, updatedAt: number) =>
      first.server.store.run(
        `INSERT INTO core_jobs (id, kind, key, subject, state, step, attempts, created_at, updated_at)
         VALUES (?, 'x.kind', NULL, '{}', ?, 'only', 0, ?, ?)`,
        id,
        state,
        START,
        updatedAt,
      );
    insert("old-done", "done", START);
    insert("old-cancelled", "cancelled", START);
    insert("new-done", "done", START + 10 * DAY);
    insert("old-running", "running", START);
    first.server.close();
    servers.pop();

    const server = await start(BASE, { startAt: START + 31 * DAY, firstId: 1000 });

    const ids = server.store
      .all<{ id: string }>("SELECT id FROM core_jobs ORDER BY id")
      .map((row) => row.id);
    expect(ids).toEqual(["new-done", "old-running"]);
  });

  it("leaves the folder of an in-place workspace alone", async () => {
    setDays(30);
    const { server, workspace, folder } = await archivedThenRestarted(31);

    expect(await status(server, workspace.id)).toBe(404);
    expect(existsSync(join(folder, "keep.txt"))).toBe(true);
  });
});
