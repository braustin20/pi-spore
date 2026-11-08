import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { type Artifacts, ArtifactsKey, artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { COORDINATOR_TOOLS, type Runs, RunsKey, runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { BridgeCaller, JobView, ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type {
  Approval,
  Lane,
  PipelineRun,
  Run,
  StartLaneRequest,
  Workspace,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeModule } from "./server.js";
import { asAgent, chat, json, until } from "./testing.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let scratch: string;
let servers: { server: TestServer; agents: ReturnType<typeof createAgentsModule> }[];
let runs: Runs;
let artifacts: Artifacts;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-runs-")));
  servers = [];
});
afterEach(async () => {
  for (const { server, agents } of servers) {
    await agents.manager().stopAll();
    server.close();
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A module that hands the tests the interfaces the bridge will call in slice 4. */
const probe: ServerModule = {
  id: "runs-probe",
  requires: ["runs", "artifacts"],
  core: false,
  setup(host) {
    runs = host.use(RunsKey);
    artifacts = host.use(ArtifactsKey);
  },
};

const TIERS = { "fake/weak": "local", "fake/mid": "medium", "fake/strong": "heavy" };

/** A worker pipeline stage that the tests report by hand, so they control when a lane passes. */
const IMPLEMENT = `id = "p"

[[stage]]
name = "implement"
role = "worker"
tier = "route"
`;

async function start(options: { home?: string; firstId?: number; record?: boolean } = {}) {
  const script = join(scratch, "script.json");
  writeFileSync(script, JSON.stringify({ worker: ["hang", "hang", "hang"] }));
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({ provider: "fake", modelId: "mid" }),
    baseEnv: {
      PATH: process.env.PATH,
      FAKE_PI_SCRIPT: script,
      FAKE_PI_RECORD: join(scratch, "record.jsonl"),
    },
    idleStopMs: 60_000,
    startTimeoutMs: 1_000,
  });
  const server = await createTestServer(
    [
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      agents,
      actionsModule,
      attentionModule,
      artifactsModule,
      kanbanModule,
      pipelinesModule,
      runsModule,
      bridgeModule,
      probe,
    ],
    {
      listen: true,
      ...(options.home ? { home: options.home } : {}),
      ...(options.firstId ? { firstId: options.firstId } : {}),
    },
  );
  servers.push({ server, agents });
  mkdirSync(join(server.paths.root, "pipelines"), { recursive: true });
  writeFileSync(join(server.paths.root, "pipelines", "p.toml"), IMPLEMENT);
  writeFileSync(join(server.paths.root, "settings.json"), JSON.stringify({ tiers: TIERS }));
  return server;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A git project on `main` with one commit. */
async function project(server: TestServer, name: string) {
  const folder = join(scratch, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.txt"), "one\n");
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "base");
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  return { projectId: project.id, folder };
}

async function createRun(server: TestServer, projectId: string, name: string) {
  const { run } = await json<{ run: Run }>(
    await server.request("POST", "/api/runs", { projectId, name }),
    201,
  );
  const coordinator: BridgeCaller = {
    agentId: run.coordinatorAgentId,
    workspaceId: run.workspaceId,
  };
  return { run, coordinator };
}

const getRun = async (server: TestServer, id: string) =>
  (await json<{ run: Run }>(await server.request("GET", `/api/runs/${id}`))).run;
const laneOf = async (server: TestServer, runId: string, laneId: string) =>
  (await getRun(server, runId)).lanes.find((lane) => lane.id === laneId) as Lane;
const workspaceOf = async (server: TestServer, id: string) =>
  (await json<{ workspace: Workspace }>(await server.request("GET", `/api/workspaces/${id}`)))
    .workspace;

/** Writes a brief into the run workspace and starts a lane on it. */
async function startLane(
  run: Run,
  coordinator: BridgeCaller,
  name: string,
  request: Partial<StartLaneRequest> = {},
) {
  const brief = `briefs/${name}.md`;
  await artifacts.write({ scope: "workspace", id: run.workspaceId }, brief, `Build ${name}`);
  return runs.startLane(coordinator, { name, brief, wave: 1, pipeline: "p", ...request });
}

const laneJob = (server: TestServer, laneId: string) =>
  server.services.jobs.list({ kind: "runs.lane", key: laneId })[0] as JobView;

/** The worker stage agent of a lane's pipeline run, once it has one. */
async function laneWorker(server: TestServer, lane: Lane) {
  let found: PipelineRun | undefined;
  await until(async () => {
    const { runs: pipelineRuns } = await json<{ runs: PipelineRun[] }>(
      await server.request("GET", `/api/pipelines/workspaces/${lane.workspaceId}/runs`),
    );
    found = pipelineRuns.find((entry) => entry.workerAgentId !== undefined);
    return found !== undefined;
  });
  const turn = found?.turns[0];
  return { agentId: turn?.agentId as string, turnId: turn?.id as string };
}

/** Reports the lane's worker turn, so its pipeline passes. */
async function passLane(server: TestServer, runId: string, laneId: string) {
  await until(async () => (await laneOf(server, runId, laneId)).state === "running");
  const lane = await laneOf(server, runId, laneId);
  const worker = await laneWorker(server, lane);
  await json(
    await asAgent(server, worker.agentId, lane.workspaceId as string)("POST", "reports", {
      turn: worker.turnId,
      summary: "Done",
    }),
  );
  await until(async () => (await laneOf(server, runId, laneId)).state === "passed");
}

const launches = () =>
  readFileSync(join(scratch, "record.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> });
const launchOf = (agentId: string) =>
  launches().find((entry) => entry.env.PI_SPORE_AGENT_ID === agentId);

const openApprovals = async (server: TestServer) =>
  (
    await json<{ approvals: Approval[] }>(
      await server.request("GET", "/api/attention/approvals?state=open"),
    )
  ).approvals;

describe("creating a run", () => {
  it("makes run/<slug>-<short> at the base, a run workspace on it, and a coordinator chat", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "create");
    const before = git(folder, "rev-parse", "main");

    const { run } = await createRun(server, projectId, "Big Feature");

    expect(run.line).toMatch(/^run\/big-feature-[0-9a-z]{6}$/);
    expect(run).toMatchObject({ base: "main", gates: ["check", "test"], lanes: [] });
    expect(git(folder, "rev-parse", run.line)).toBe(before);
    expect(git(folder, "rev-parse", "main")).toBe(before);
    expect(await workspaceOf(server, run.workspaceId)).toMatchObject({
      isolation: "existing",
      line: run.line,
      base: "main",
    });
    const { agent } = await json<{ agent: { kind: string; workspaceId: string } }>(
      await server.request("GET", `/api/agents/${run.coordinatorAgentId}`),
    );
    expect(agent).toMatchObject({ kind: "worker", workspaceId: run.workspaceId });
    const listed = await json<{ runs: Run[] }>(
      await server.request("GET", `/api/runs?projectId=${projectId}`),
    );
    expect(listed.runs.map((entry) => entry.id)).toEqual([run.id]);
  });

  it("answers 422 not_supported for a project without a provider that integrates", async () => {
    const server = await start();
    const folder = join(scratch, "plain");
    mkdirSync(folder);
    const { project: plain } = await json<{ project: { id: string } }>(
      await server.request("POST", "/api/projects", { path: folder }),
      201,
    );

    const response = await server.request("POST", "/api/runs", { projectId: plain.id, name: "x" });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "not_supported" } });
  });
});

describe("launch context", () => {
  it("launches the coordinator read-only and a lane's stage agent as a lane", async () => {
    const server = await start();
    const { projectId } = await project(server, "context");
    const { run, coordinator } = await createRun(server, projectId, "ctx");
    await json(
      await server.request("POST", `/api/agents/${run.coordinatorAgentId}/prompt`, {
        message: "hello",
      }),
    );
    await until(() => launchOf(run.coordinatorAgentId) !== undefined);

    const lane = await startLane(run, coordinator, "one");
    await until(async () => (await laneOf(server, run.id, lane.id)).state === "running");
    const worker = await laneWorker(server, await laneOf(server, run.id, lane.id));
    await until(() => launchOf(worker.agentId) !== undefined);

    const coordinatorLaunch = launchOf(run.coordinatorAgentId);
    const { argv, env } = coordinatorLaunch as NonNullable<typeof coordinatorLaunch>;
    expect(env).toMatchObject({ PI_SPORE_RUN_ID: run.id, PI_SPORE_RUN_ROLE: "coordinator" });
    expect(argv[argv.indexOf("--tools") + 1]).toBe(COORDINATOR_TOOLS.join(","));
    expect(launchOf(worker.agentId)?.env).toMatchObject({
      PI_SPORE_RUN_ID: run.id,
      PI_SPORE_RUN_ROLE: "lane",
    });
    expect(launchOf(worker.agentId)?.argv).not.toContain("--tools");
  });
});

describe("a lane", () => {
  it("starts at once in wave 1 from the run line, passes, and tells the coordinator where its diff is", async () => {
    const server = await start();
    const { projectId } = await project(server, "lane");
    const { run, coordinator } = await createRun(server, projectId, "lane");

    const lane = await startLane(run, coordinator, "feature");
    expect(lane.state).toBe("waiting");
    await until(async () => (await laneOf(server, run.id, lane.id)).state === "running");
    const started = await laneOf(server, run.id, lane.id);
    const workspace = await workspaceOf(server, started.workspaceId as string);
    expect(workspace.base).toBe(run.line);
    writeFileSync(join(workspace.path, "feature.txt"), "lane change\n");
    git(workspace.path, "add", ".");
    git(workspace.path, "commit", "-q", "-m", "lane work");
    await passLane(server, run.id, lane.id);

    const diffPath = `runs/${run.id}/lanes/${lane.id}.diff`;
    await until(async () =>
      (await chat(server, run.coordinatorAgentId)).some((message) => message.includes(diffPath)),
    );
    const message = (await chat(server, run.coordinatorAgentId)).find((entry) =>
      entry.includes(diffPath),
    );
    expect(message).toContain(`"feature" (${lane.id}) passed`);
    expect(message).toContain("merge_lane");
    expect(message).toContain("revise_lane");
    const diff = await artifacts.read({ scope: "workspace", id: run.workspaceId }, diffPath);
    expect(diff.bytes.toString("utf8")).toContain("+lane change");
    expect(runs.laneOf(started.workspaceId as string)).toEqual({ runId: run.id, laneId: lane.id });
    expect(runs.runOf(run.workspaceId)?.id).toBe(run.id);
  });

  it("keeps a wave-2 lane waiting, with no workspace, until the wave-1 lane is merged", async () => {
    const server = await start();
    const { projectId } = await project(server, "waves");
    const { run, coordinator } = await createRun(server, projectId, "waves");
    const first = await startLane(run, coordinator, "first");
    const second = await startLane(run, coordinator, "second", { wave: 2 });
    await until(() => laneJob(server, second.id).state === "waiting");
    expect(await laneOf(server, run.id, second.id)).toMatchObject({ state: "waiting" });

    await passLane(server, run.id, first.id);
    await until(() => laneJob(server, first.id).state === "done");

    const waiting = await laneOf(server, run.id, second.id);
    expect(waiting.state).toBe("waiting");
    expect(waiting.workspaceId).toBeUndefined();
    expect(laneJob(server, second.id).state).toBe("waiting");
  });

  it("refuses a missing brief with 404 and a dependsOn that is not a lane of the run with 400", async () => {
    const server = await start();
    const { projectId } = await project(server, "refuse");
    const { run, coordinator } = await createRun(server, projectId, "refuse");

    await expect(
      runs.startLane(coordinator, { name: "x", brief: "briefs/none.md", wave: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(startLane(run, coordinator, "y", { dependsOn: ["nope"] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      runs.startLane({ agentId: "a", workspaceId: "w" }, { name: "x", brief: "b.md", wave: 1 }),
    ).rejects.toMatchObject({ status: 403, code: "not_coordinator" });
  });
});

describe("the lane model approval (R4.8)", () => {
  it("files a lane-model approval for a tier above the worker default; approve starts the lane", async () => {
    const server = await start();
    const { projectId } = await project(server, "approve");
    const { run, coordinator } = await createRun(server, projectId, "approve");

    const weak = await startLane(run, coordinator, "weak", { model: "fake/weak" });
    const strong = await startLane(run, coordinator, "strong", { model: "fake/strong" });

    expect(weak.state).toBe("waiting");
    expect(strong.state).toBe("approval");
    const [approval] = await openApprovals(server);
    expect(approval).toMatchObject({
      kind: "lane-model",
      subject: { laneId: strong.id },
      agentId: run.coordinatorAgentId,
    });
    expect(approval?.reason).toContain("R4.8");
    expect(approval?.reason).toContain("fake/strong is tier heavy");
    expect(approval?.reason).toContain("fake/mid is tier medium");
    await until(async () => (await laneOf(server, run.id, weak.id)).state === "running");
    expect((await laneOf(server, run.id, strong.id)).workspaceId).toBeUndefined();

    await json(
      await server.request("POST", `/api/attention/approvals/${approval?.id}/approve`, {}),
    );

    await until(async () => (await laneOf(server, run.id, strong.id)).state === "running");
  });

  it("makes a declined lane declined, and a lane of a later wave no longer waits for it", async () => {
    const server = await start();
    const { projectId } = await project(server, "decline");
    const { run, coordinator } = await createRun(server, projectId, "decline");
    const strong = await startLane(run, coordinator, "strong", { model: "fake/strong" });
    const next = await startLane(run, coordinator, "next", { wave: 2 });
    await until(() => laneJob(server, next.id).state === "waiting");
    const [approval] = await openApprovals(server);

    await json(
      await server.request("POST", `/api/attention/approvals/${approval?.id}/decline`, {}),
    );

    expect((await laneOf(server, run.id, strong.id)).state).toBe("declined");
    await until(async () => (await laneOf(server, run.id, next.id)).state === "running");
  });
});

describe("a restart", () => {
  it("keeps a lane that waits for its wave waiting", async () => {
    const home = join(scratch, "home");
    const first = await start({ home });
    const { projectId } = await project(first, "restart");
    const { run, coordinator } = await createRun(first, projectId, "restart");
    await startLane(run, coordinator, "one");
    const second = await startLane(run, coordinator, "two", { wave: 2 });
    await until(() => laneJob(first, second.id).state === "waiting");
    const entry = servers.pop();
    await entry?.agents.manager().stopAll();
    entry?.server.close();

    const restarted = await start({ home, firstId: 1_000 });

    await until(() => laneJob(restarted, second.id).state === "waiting");
    const lane = await laneOf(restarted, run.id, second.id);
    expect(lane.state).toBe("waiting");
    expect(lane.workspaceId).toBeUndefined();
  });
});
