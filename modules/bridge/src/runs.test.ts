import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  RunEvent,
  StartLaneRequest,
  Workspace,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeModule } from "./server.js";
import { asAgent, chat, json, until } from "./testing.js";

const GATE_ACTION = fileURLToPath(new URL("../test-fixtures/gate-action.mjs", import.meta.url));
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
  // A lane job may still write in its worktree when the server closes; rmSync retries ENOTEMPTY.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
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

/** config.toml text that declares each gate action as the gate-action fixture in the given mode. */
const gateConfig = (modes: Record<string, string>) =>
  Object.entries(modes)
    .map(
      ([name, mode]) =>
        `[actions.${name}]\nrun = ${JSON.stringify([process.execPath, GATE_ACTION, join(scratch, "counter.txt"), name, mode])}\n`,
    )
    .join("\n");

/** A git project on `main` with one commit. Gate actions are committed, so the run worktree sees them. */
async function project(server: TestServer, name: string, gates: Record<string, string> = {}) {
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(join(folder, ".pi-spore", "config.toml"), gateConfig(gates));
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

/** Commits a file in a lane's workspace, as its worker would, and passes the lane. */
async function laneChanges(
  server: TestServer,
  run: Run,
  laneId: string,
  file: string,
  content: string,
) {
  await until(async () => (await laneOf(server, run.id, laneId)).state === "running");
  const workspace = await workspaceOf(
    server,
    (await laneOf(server, run.id, laneId)).workspaceId as string,
  );
  writeFileSync(join(workspace.path, file), content);
  git(workspace.path, "add", ".");
  git(workspace.path, "commit", "-q", "-m", `change ${file}`);
  await passLane(server, run.id, laneId);
}

const untilDelivered = (server: TestServer, agentId: string, text: string) =>
  until(async () => (await chat(server, agentId)).some((message) => message.includes(text)));
/** The agent's first message that holds `text`. A delivery reaches the chat after the commit that wrote it. */
const deliveredWith = async (server: TestServer, agentId: string, text: string) => {
  let found: string | undefined;
  await until(async () => {
    found = (await chat(server, agentId)).find((message) => message.includes(text));
    return found !== undefined;
  });
  return found as string;
};

describe("merging a lane (ADR 0150)", () => {
  const GREEN = { check: "pass", test: "pass" };

  it("merges a passed lane into the run line after its gates pass, then starts the next wave from it", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "merge", GREEN);
    const main = git(folder, "rev-parse", "main");
    const { run, coordinator } = await createRun(server, projectId, "merge");
    const first = await startLane(run, coordinator, "first");
    const second = await startLane(run, coordinator, "second", { wave: 2 });
    await laneChanges(server, run, first.id, "feature.txt", "lane change\n");
    const before = git(folder, "rev-parse", run.line);

    const merging = await runs.mergeLane(coordinator, { laneId: first.id });

    expect(merging.state).toBe("merging");
    await until(async () => (await laneOf(server, run.id, first.id)).state === "merged");
    expect(git(folder, "rev-parse", `${run.line}^1`)).toBe(before);
    expect(git(folder, "log", "-1", "--format=%s", run.line)).toBe(
      `Merge lane first (${first.id})`,
    );
    expect(git(folder, "show", `${run.line}:feature.txt`)).toBe("lane change");
    const delivery = await deliveredWith(server, run.coordinatorAgentId, "is merged into");
    expect(delivery).toContain("gates passed");
    expect(delivery).not.toContain("All lanes");
    await until(async () => (await laneOf(server, run.id, second.id)).state === "running");
    const next = await workspaceOf(
      server,
      (await laneOf(server, run.id, second.id)).workspaceId as string,
    );
    expect(readFileSync(join(next.path, "feature.txt"), "utf8")).toBe("lane change\n");
    expect(git(folder, "rev-parse", "main")).toBe(main);
  });

  it("puts a conflicting lane back to passed, names the files, and leaves the run line alone", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "conflict", GREEN);
    const main = git(folder, "rev-parse", "main");
    const { run, coordinator } = await createRun(server, projectId, "conflict");
    const lane = await startLane(run, coordinator, "clash");
    await laneChanges(server, run, lane.id, "a.txt", "lane\n");
    const runWorkspace = await workspaceOf(server, run.workspaceId);
    writeFileSync(join(runWorkspace.path, "a.txt"), "run\n");
    git(runWorkspace.path, "add", ".");
    git(runWorkspace.path, "commit", "-q", "-m", "run change");
    const before = git(folder, "rev-parse", run.line);

    await runs.mergeLane(coordinator, { laneId: lane.id });

    await untilDelivered(server, run.coordinatorAgentId, "conflicts with");
    const delivery = await deliveredWith(server, run.coordinatorAgentId, "conflicts with");
    expect(delivery).toContain("a.txt");
    expect(delivery).toContain("revise_lane");
    expect(delivery).toContain(`merge ${run.line} into its branch`);
    expect(await laneOf(server, run.id, lane.id)).toMatchObject({
      state: "passed",
      message: "merge conflict in a.txt",
    });
    expect(git(folder, "rev-parse", run.line)).toBe(before);
    expect(git(runWorkspace.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(git(runWorkspace.path, "rev-parse", "--git-dir"), "MERGE_HEAD"))).toBe(
      false,
    );
    expect(git(folder, "rev-parse", "main")).toBe(main);
  });

  it("aborts the merge when a gate fails on the merged tree, and tells the coordinator the diff and the log", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "red", { check: "pass", test: "fail" });
    const main = git(folder, "rev-parse", "main");
    const { run, coordinator } = await createRun(server, projectId, "red");
    const lane = await startLane(run, coordinator, "bad");
    await laneChanges(server, run, lane.id, "feature.txt", "broken\n");
    const before = git(folder, "rev-parse", run.line);

    await runs.mergeLane(coordinator, { laneId: lane.id });

    await untilDelivered(server, run.coordinatorAgentId, "gate test failed");
    const diffPath = `runs/${run.id}/lanes/${lane.id}-gates.diff`;
    const delivery = await deliveredWith(server, run.coordinatorAgentId, "gate test failed");
    expect(delivery).toContain(diffPath);
    expect(delivery).toContain("gate output: boom");
    expect(delivery).toContain("revise_lane");
    expect(await laneOf(server, run.id, lane.id)).toMatchObject({
      state: "passed",
      message: "gate test failed",
    });
    const diff = await artifacts.read({ scope: "workspace", id: run.workspaceId }, diffPath);
    expect(diff.bytes.toString("utf8")).toContain("+broken");
    const runWorkspace = await workspaceOf(server, run.workspaceId);
    expect(git(folder, "rev-parse", run.line)).toBe(before);
    expect(git(runWorkspace.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(runWorkspace.path, "feature.txt"))).toBe(false);
    expect(git(folder, "rev-parse", "main")).toBe(main);
  });

  it("tells the coordinator to open the one PR when the last lane is merged", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "last", GREEN);
    const main = git(folder, "rev-parse", "main");
    const { run, coordinator } = await createRun(server, projectId, "last");
    const lane = await startLane(run, coordinator, "only");
    await laneChanges(server, run, lane.id, "feature.txt", "x\n");

    await runs.mergeLane(coordinator, { laneId: lane.id });

    await untilDelivered(server, run.coordinatorAgentId, "All lanes of the run are merged");
    const delivery = await deliveredWith(server, run.coordinatorAgentId, "All lanes");
    expect(delivery).toContain("PR tab");
    expect(git(folder, "rev-parse", "main")).toBe(main);
  });

  it("refuses a lane that is not passed with 409 lane_not_mergeable, and a stranger lane with 404", async () => {
    const server = await start();
    const { projectId } = await project(server, "refuse-merge", GREEN);
    const { run, coordinator } = await createRun(server, projectId, "refuse-merge");
    const lane = await startLane(run, coordinator, "early");

    await expect(runs.mergeLane(coordinator, { laneId: lane.id })).rejects.toMatchObject({
      status: 409,
      code: "lane_not_mergeable",
    });
    await expect(runs.mergeLane(coordinator, { laneId: "nope" })).rejects.toMatchObject({
      status: 404,
      code: "lane_not_found",
    });
    await expect(
      runs.mergeLane({ agentId: "a", workspaceId: "w" }, { laneId: lane.id }),
    ).rejects.toMatchObject({ status: 403, code: "not_coordinator" });
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

/** A started lane whose worker stage agent is up, with a bridge client for it and for the coordinator. */
async function laneWithWorker(server: TestServer, run: Run, coordinator: BridgeCaller) {
  const started = await startLane(run, coordinator, "asker");
  await until(async () => (await laneOf(server, run.id, started.id)).state === "running");
  const lane = await laneOf(server, run.id, started.id);
  const worker = await laneWorker(server, lane);
  return {
    lane,
    worker: worker.agentId,
    asWorker: asAgent(server, worker.agentId, lane.workspaceId as string),
    asCoordinator: asAgent(server, coordinator.agentId, coordinator.workspaceId),
  };
}

describe("bridge routes for a run (R7.3)", () => {
  it("lets the coordinator start a lane, and refuses a lane agent with 403 not_coordinator", async () => {
    const server = await start();
    const { projectId } = await project(server, "route-start");
    const { run, coordinator } = await createRun(server, projectId, "route-start");
    await artifacts.write(
      { scope: "workspace", id: run.workspaceId },
      "briefs/one.md",
      "Build one",
    );
    const body = { name: "one", brief: "briefs/one.md", wave: 1, pipeline: "p" };

    const started = await json<{ lane: Lane }>(
      await asAgent(server, coordinator.agentId, run.workspaceId)("POST", "lanes", body),
      201,
    );

    expect(started.lane).toMatchObject({ name: "one", runId: run.id, state: "waiting" });
    const { asWorker } = await laneWithWorker(server, run, coordinator);
    const refused = await asWorker("POST", "lanes", body);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "not_coordinator" } });
  });
});

describe("questions up the chain (R7.5, ADR 0008)", () => {
  it("delivers a lane agent's question to the coordinator's chat with no call from the coordinator", async () => {
    const server = await start();
    const { projectId } = await project(server, "ask");
    const { run, coordinator } = await createRun(server, projectId, "ask");
    const { lane, asWorker } = await laneWithWorker(server, run, coordinator);

    const { question } = await json<{ question: { id: string; state: string } }>(
      await asWorker("POST", "coordinator/questions", { question: "Which hash?" }),
      201,
    );

    expect(question.state).toBe("open");
    await untilDelivered(server, run.coordinatorAgentId, question.id);
    const message = await deliveredWith(server, run.coordinatorAgentId, question.id);
    expect(message).toContain(`"asker" (${lane.id})`);
    expect(message).toContain("Which hash?");
    expect(message).toContain("answer_lane");
    expect(message).toContain("request_human_input");
  });

  it("keeps a question across a restart and delivers it when the coordinator can take it", async () => {
    const home = join(scratch, "home");
    const first = await start({ home });
    const { projectId } = await project(first, "ask-restart");
    const { run, coordinator } = await createRun(first, projectId, "ask-restart");
    const { asWorker } = await laneWithWorker(first, run, coordinator);
    await json(await first.request("POST", `/api/workspaces/${run.workspaceId}/park`));
    const { question } = await json<{ question: { id: string } }>(
      await asWorker("POST", "coordinator/questions", { question: "Still there?" }),
      201,
    );
    const entry = servers.pop();
    await entry?.agents.manager().stopAll();
    entry?.server.close();

    const restarted = await start({ home, firstId: 1_000 });
    await json(await restarted.request("POST", `/api/workspaces/${run.workspaceId}/resume`));

    await untilDelivered(restarted, run.coordinatorAgentId, question.id);
    expect(await deliveredWith(restarted, run.coordinatorAgentId, question.id)).toContain(
      "Still there?",
    );
  });

  it("delivers the coordinator's answer to the asking agent, and refuses a second answer with 409", async () => {
    const server = await start();
    const { projectId } = await project(server, "answer");
    const { run, coordinator } = await createRun(server, projectId, "answer");
    const { worker, asWorker, asCoordinator } = await laneWithWorker(server, run, coordinator);
    const { question } = await json<{ question: { id: string } }>(
      await asWorker("POST", "coordinator/questions", { question: "Which hash?" }),
      201,
    );

    const refused = await asWorker("POST", "coordinator/answers", {
      questionId: question.id,
      answer: "sha256",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "not_coordinator" } });
    const answered = await json<{ question: { state: string; answer: string } }>(
      await asCoordinator("POST", "coordinator/answers", {
        questionId: question.id,
        answer: "sha256",
      }),
    );

    expect(answered.question).toMatchObject({ state: "answered", answer: "sha256" });
    await untilDelivered(server, worker, "Answer: sha256");
    const message = await deliveredWith(server, worker, "Answer: sha256");
    expect(message).toContain(question.id);
    expect(message).toContain("Which hash?");
    const second = await asCoordinator("POST", "coordinator/answers", {
      questionId: question.id,
      answer: "md5",
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "question_answered" } });
    const unknown = await asCoordinator("POST", "coordinator/answers", {
      questionId: "nope",
      answer: "x",
    });
    expect(unknown.status).toBe(404);
  });

  it("refuses request_human_input from a lane agent with 409 ask_coordinator, and still takes the coordinator's", async () => {
    const server = await start();
    const { projectId } = await project(server, "human");
    const { run, coordinator } = await createRun(server, projectId, "human");
    const { asWorker, asCoordinator } = await laneWithWorker(server, run, coordinator);

    const refused = await asWorker("POST", "questions", { question: "Which hash?" });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "ask_coordinator" } });
    await json(await asCoordinator("POST", "questions", { question: "Which hash?" }), 201);
  });

  it("refuses a caller outside a lane with 403 not_in_lane", async () => {
    const server = await start();
    const { projectId } = await project(server, "no-lane");
    const { run, coordinator } = await createRun(server, projectId, "no-lane");

    const refused = await asAgent(server, coordinator.agentId, run.workspaceId)(
      "POST",
      "coordinator/questions",
      { question: "Who am I?" },
    );

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "not_in_lane" } });
  });
});

describe("the runs:list topic", () => {
  it("gives every run on subscribe, and a new snapshot when a lane changes state", async () => {
    const server = await start();
    const { projectId } = await project(server, "topic");
    const { run, coordinator } = await createRun(server, projectId, "topic");

    const [snapshot] = (await server.events.snapshot("runs:list")) as RunEvent[];
    expect(snapshot?.runs.map((entry) => entry.id)).toEqual([run.id]);

    const lane = await startLane(run, coordinator, "one");
    await until(async () => (await laneOf(server, run.id, lane.id)).state === "running");
    const states = () =>
      (server.events.eventsOf("runs:list") as RunEvent[]).map(
        (event) => event.runs[0]?.lanes[0]?.state,
      );
    expect(states()).toContain("waiting");
    expect(states().at(-1)).toBe("running");
  });
});

describe("cancelling a run (ADR 0150)", () => {
  const NOT_ENDED = ["running", "waiting", "interrupted"] as const;
  const cancel = (server: TestServer, runId: string) =>
    server.request("POST", `/api/runs/${runId}/cancel`);
  const agentStatus = async (server: TestServer, agentId: string) =>
    (
      await json<{ agent: { status: string } }>(
        await server.request("GET", `/api/agents/${agentId}`),
      )
    ).agent.status;
  const notEnded = (server: TestServer, kind: string) =>
    server.services.jobs.list({ kind, states: NOT_ENDED });

  it("cancels the run and its lanes, stops their pipeline runs and agents, and deletes nothing", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "cancel");
    const { run, coordinator } = await createRun(server, projectId, "cancel");
    await json(
      await server.request("POST", `/api/agents/${run.coordinatorAgentId}/prompt`, {
        message: "hello",
      }),
    );
    await until(() => launchOf(run.coordinatorAgentId) !== undefined);
    const running = await startLane(run, coordinator, "running");
    const waiting = await startLane(run, coordinator, "waiting", { wave: 2 });
    await until(async () => (await laneOf(server, run.id, running.id)).state === "running");
    const started = await laneOf(server, run.id, running.id);
    const worker = await laneWorker(server, started);
    await until(() => launchOf(worker.agentId) !== undefined);
    const lineBefore = git(folder, "rev-parse", run.line);

    const response = await cancel(server, run.id);

    const { run: cancelled } = await json<{ run: Run }>(response);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.lanes.map((lane) => lane.state)).toEqual(["cancelled", "cancelled"]);
    expect(cancelled.lanes[0]?.message).toBe("Cancelled with the run");
    const { runs: pipelineRuns } = await json<{ runs: PipelineRun[] }>(
      await server.request("GET", `/api/pipelines/workspaces/${started.workspaceId}/runs`),
    );
    expect(pipelineRuns.map((entry) => entry.state)).toEqual(["stopped"]);
    expect(await agentStatus(server, worker.agentId)).toBe("stopped");
    expect(await agentStatus(server, run.coordinatorAgentId)).toBe("stopped");
    expect(notEnded(server, "runs.lane")).toEqual([]);
    expect(waiting.id).toBeDefined();
    const laneLine = (await workspaceOf(server, started.workspaceId as string)).line as string;
    expect(git(folder, "branch", "--list", laneLine)).toContain(laneLine);
    expect(git(folder, "rev-parse", run.line)).toBe(lineBefore);
  });

  it("aborts a merge in progress and leaves the run worktree clean", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "cancel-merge", {
      check: "hang-first",
      test: "pass",
    });
    const { run, coordinator } = await createRun(server, projectId, "cancel-merge");
    const lane = await startLane(run, coordinator, "work");
    await laneChanges(server, run, lane.id, "feature.txt", "lane change\n");
    const lineBefore = git(folder, "rev-parse", run.line);
    await runs.mergeLane(coordinator, { laneId: lane.id });
    await until(() => existsSync(join(scratch, "counter.txt")));

    await json(await cancel(server, run.id));

    expect((await laneOf(server, run.id, lane.id)).state).toBe("cancelled");
    const runWorkspace = await workspaceOf(server, run.workspaceId);
    expect(git(runWorkspace.path, "status", "--porcelain")).toBe("");
    expect(() => git(runWorkspace.path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(git(folder, "rev-parse", run.line)).toBe(lineBefore);
    expect(server.services.jobs.list({ kind: "runs.merge" }).map((job) => job.state)).toEqual([
      "cancelled",
    ]);
    const { runs: gateRuns } = await json<{ runs: { action: string; status: string }[] }>(
      await server.request("GET", `/api/actions/workspaces/${run.workspaceId}/runs`),
    );
    expect(
      gateRuns.filter((entry) => entry.action === "check").map((entry) => entry.status),
    ).toEqual(["cancelled"]);
  });

  it("keeps a merged lane merged", async () => {
    const server = await start();
    const { projectId } = await project(server, "cancel-merged", { check: "pass", test: "pass" });
    const { run, coordinator } = await createRun(server, projectId, "cancel-merged");
    const first = await startLane(run, coordinator, "first");
    await laneChanges(server, run, first.id, "feature.txt", "x\n");
    await runs.mergeLane(coordinator, { laneId: first.id });
    await until(async () => (await laneOf(server, run.id, first.id)).state === "merged");
    const second = await startLane(run, coordinator, "second");

    await json(await cancel(server, run.id));

    expect((await laneOf(server, run.id, first.id)).state).toBe("merged");
    expect((await laneOf(server, run.id, second.id)).state).toBe("cancelled");
  });

  it("refuses the run tools with 409 run_cancelled afterwards, and a second cancel answers 200", async () => {
    const server = await start();
    const { projectId } = await project(server, "cancel-tools");
    const { run, coordinator } = await createRun(server, projectId, "cancel-tools");
    const lane = await startLane(run, coordinator, "one");
    await json(await cancel(server, run.id));
    const refused = { status: 409, code: "run_cancelled" };

    await expect(startLane(run, coordinator, "two")).rejects.toMatchObject(refused);
    await expect(
      runs.reviseLane(coordinator, { laneId: lane.id, brief: "briefs/one.md" }),
    ).rejects.toMatchObject(refused);
    await expect(runs.mergeLane(coordinator, { laneId: lane.id })).rejects.toMatchObject(refused);
    expect(() => runs.answerLane(coordinator, { questionId: "q", answer: "a" })).toThrow(
      expect.objectContaining(refused),
    );
    const again = await json<{ run: Run }>(await cancel(server, run.id));
    expect(again.run.state).toBe("cancelled");
  });

  it("drops a delivery the coordinator has not taken", async () => {
    const server = await start();
    const { projectId } = await project(server, "cancel-delivery");
    const { run, coordinator } = await createRun(server, projectId, "cancel-delivery");
    const { asWorker } = await laneWithWorker(server, run, coordinator);
    // A parked workspace takes no delivery, so the question stays pending.
    await json(await server.request("POST", `/api/workspaces/${run.workspaceId}/park`));
    await json(await asWorker("POST", "coordinator/questions", { question: "Which hash?" }), 201);
    const pending = () =>
      server.store.all(
        "SELECT 1 FROM agents_deliveries WHERE agent_id = ? AND state = 'pending'",
        run.coordinatorAgentId,
      );
    expect(pending()).toHaveLength(1);

    await json(await cancel(server, run.id));

    expect(pending()).toEqual([]);
  });

  it("answers 404 run_not_found for an unknown run", async () => {
    const server = await start();

    const response = await cancel(server, "nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "run_not_found" } });
  });
});
