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
import { createGithubPrModule } from "@pi-spore/mod-github-pr/server";
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
  RunPrSubject,
  RunStatus,
  StartLaneRequest,
  Workspace,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeModule } from "./server.js";
import { asAgent, chat, json, until } from "./testing.js";

const GATE_ACTION = fileURLToPath(new URL("../test-fixtures/gate-action.mjs", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));
const FAKE_GH = fileURLToPath(
  new URL("../../github-pr/test-fixtures/fake-gh.mjs", import.meta.url),
);

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
    // A job could start an agent after stopAll; it would exit after the store closed.
    server.services.jobs.stop();
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

/** A worker stage, then a gate stage that runs the `lint` action. */
const LINT_PIPELINE = `id = "lint"

[[stage]]
name = "implement"
role = "worker"
tier = "route"

[[stage]]
name = "gates"
gates = ["lint"]
`;

/** Pi exits at once while this file exists, so a delivery to an agent that is not running stays pending. */
const PI_DOWN = () => join(scratch, "pi-down");

/** The fake GitHub's state file: every `gh` call is recorded in it. */
const ghState = () => join(scratch, "gh.json");

async function start(
  options: {
    home?: string;
    firstId?: number;
    record?: boolean;
    withoutGithubPr?: boolean;
    script?: Record<string, unknown[]>;
  } = {},
) {
  const script = join(scratch, "script.json");
  if (!existsSync(ghState())) writeFileSync(ghState(), JSON.stringify({ prs: [] }));
  writeFileSync(script, JSON.stringify(options.script ?? { worker: ["hang", "hang", "hang"] }));
  const wrapper = join(scratch, "pi-wrapper.mjs");
  writeFileSync(
    wrapper,
    `import { existsSync } from "node:fs";\nif (existsSync(${JSON.stringify(PI_DOWN())})) process.exit(1);\nawait import(${JSON.stringify(FAKE_PI)});\n`,
  );
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [wrapper] },
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
      ...(options.withoutGithubPr
        ? []
        : [
            createGithubPrModule({
              gh: { command: process.execPath, args: [FAKE_GH, ghState()] },
            }),
          ]),
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
    expect(COORDINATOR_TOOLS).toEqual(
      expect.arrayContaining(["kanban_list_cards", "kanban_add_card"]),
    );
    expect(COORDINATOR_TOOLS).not.toContain("kanban_update_card");
    expect(COORDINATOR_TOOLS).not.toContain("kanban_start_card");
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

  it("sends the coordinator no pipelines end message for its lane's run (ADR 0162)", async () => {
    const server = await start();
    const { projectId } = await project(server, "laneend");
    const { run, coordinator } = await createRun(server, projectId, "laneend");

    const lane = await startLane(run, coordinator, "feature");
    await passLane(server, run.id, lane.id);
    await untilDelivered(server, run.coordinatorAgentId, `"feature" (${lane.id}) passed`);

    const messages = await chat(server, run.coordinatorAgentId);
    expect(messages.filter((message) => message.includes("ended passed"))).toEqual([]);
  });

  it("tells the coordinator once when the lane's pipeline blocks on a missing gate action, and passes after the fix", async () => {
    const server = await start();
    writeFileSync(
      join(server.paths.root, "pipelines", "gated.toml"),
      `${IMPLEMENT.replace('id = "p"', 'id = "gated"')}\n[[stage]]\nname = "gates"\ngates = ["check", "test"]\n`,
    );
    const { projectId, folder } = await project(server, "blocked-gate", { test: "pass" });
    const { run, coordinator } = await createRun(server, projectId, "blocked-gate");
    const lane = await startLane(run, coordinator, "feature", { pipeline: "gated" });
    await until(async () => (await laneOf(server, run.id, lane.id)).state === "running");
    const started = await laneOf(server, run.id, lane.id);
    const worker = await laneWorker(server, started);
    await json(
      await asAgent(server, worker.agentId, started.workspaceId as string)("POST", "reports", {
        turn: worker.turnId,
        summary: "Done",
      }),
    );

    const first = await deliveredWith(server, run.coordinatorAgentId, "is blocked at stage");
    expect(first).toContain('"feature"');
    expect(first).toContain(lane.id);
    expect(first).toContain('stage "gates"');
    expect(first).toContain('"check"');
    expect(first).toContain(join(folder, ".pi-spore", "config.toml"));
    expect(first).toContain("/retry");
    const stageJob = () =>
      server.services.jobs.list({
        kind: "pipelines.stage",
        key: started.workspaceId as string,
        states: ["running", "waiting"],
      })[0] as JobView;
    const pipelineRunId = (stageJob().subject as { runId: string }).runId;
    const blockedMessages = async () =>
      (await chat(server, run.coordinatorAgentId)).filter(
        (line) => line.startsWith("user: ") && line.includes("is blocked at stage"),
      );
    expect(await blockedMessages()).toHaveLength(1);

    // The same error again sends nothing.
    const attempts = stageJob().attempts;
    await json(await server.request("POST", `/api/pipelines/runs/${pipelineRunId}/retry`));
    await until(() => stageJob().attempts > attempts && stageJob().state === "waiting");
    expect(await blockedMessages()).toHaveLength(1);

    writeFileSync(
      join(folder, ".pi-spore", "config.toml"),
      gateConfig({ check: "pass", test: "pass" }),
    );
    await json(await server.request("POST", `/api/pipelines/runs/${pipelineRunId}/retry`));
    await until(async () => (await laneOf(server, run.id, lane.id)).state === "passed");
    await untilDelivered(server, run.coordinatorAgentId, `"feature" (${lane.id}) passed`);
    expect(await blockedMessages()).toHaveLength(1);
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

describe("the review round limit of a lane", () => {
  it("names the workspace, the lane, and the run in the approval", async () => {
    const server = await start({
      script: {
        worker: [{ summary: "Done" }],
        reviewer: [{ summary: "Still wrong", verdict: "revise", findings: [] }],
      },
    });
    writeFileSync(
      join(server.paths.root, "pipelines", "limit.toml"),
      `${IMPLEMENT.replace('id = "p"', 'id = "limit"')}\n[[stage]]\nname = "review"\nrole = "reviewer"\nrounds = 1\n`,
    );
    const { projectId } = await project(server, "roundlimit");
    const { run, coordinator } = await createRun(server, projectId, "roundlimit");
    const lane = await startLane(run, coordinator, "feature", { pipeline: "limit" });

    await until(async () =>
      (await openApprovals(server)).some((entry) => entry.kind === "pipeline-round-limit"),
    );

    const approval = (await openApprovals(server)).find(
      (entry) => entry.kind === "pipeline-round-limit",
    );
    expect(approval?.title).toBe(
      `Review round limit in workspace "feature", lane "feature" (${lane.id}) of run "roundlimit": stage "review" of pipeline limit`,
    );
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

  it("tells the coordinator to call open_run_pr when the last lane is merged", async () => {
    const server = await start();
    const { projectId, folder } = await project(server, "last", GREEN);
    const main = git(folder, "rev-parse", "main");
    const { run, coordinator } = await createRun(server, projectId, "last");
    const lane = await startLane(run, coordinator, "only");
    await laneChanges(server, run, lane.id, "feature.txt", "x\n");

    await runs.mergeLane(coordinator, { laneId: lane.id });

    await untilDelivered(server, run.coordinatorAgentId, "All lanes of the run are merged");
    const delivery = await deliveredWith(server, run.coordinatorAgentId, "All lanes");
    expect(delivery).toContain("open_run_pr");
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

describe("run status", () => {
  it("shows a blocked lane on the run, live, and run_status gives each lane to the run's agents only", async () => {
    const server = await start();
    writeFileSync(
      join(server.paths.root, "pipelines", "gated.toml"),
      `${IMPLEMENT.replace('id = "p"', 'id = "gated"')}\n[[stage]]\nname = "gates"\ngates = ["check"]\n`,
    );
    const { projectId } = await project(server, "status");
    const { run, coordinator } = await createRun(server, projectId, "status");
    const done = await startLane(run, coordinator, "done");
    await passLane(server, run.id, done.id);
    const stuck = await startLane(run, coordinator, "stuck", { pipeline: "gated" });
    await until(async () => (await laneOf(server, run.id, stuck.id)).state === "running");
    const started = await laneOf(server, run.id, stuck.id);
    const worker = await laneWorker(server, started);
    await json(
      await asAgent(server, worker.agentId, started.workspaceId as string)("POST", "reports", {
        turn: worker.turnId,
        summary: "Done",
      }),
    );
    await until(async () => (await laneOf(server, run.id, stuck.id)).blocked !== undefined);

    const blocked = await laneOf(server, run.id, stuck.id);
    expect(blocked.blocked).toContain('no action "check"');
    const pipelineRun = (
      await json<{ run: PipelineRun }>(
        await server.request("GET", `/api/pipelines/runs/${blocked.pipelineRunId}`),
      )
    ).run;
    expect(pipelineRun.workspaceId).toBe(started.workspaceId);
    expect(pipelineRun.blocked).toBe(blocked.blocked);
    await until(() =>
      (server.events.eventsOf("runs:list") as RunEvent[]).some((event) =>
        event.runs[0]?.lanes.some((lane) => lane.blocked !== undefined),
      ),
    );

    const { status } = await json<{ status: RunStatus }>(
      await asAgent(server, run.coordinatorAgentId, run.workspaceId)("GET", `run-status/${run.id}`),
    );
    const doneLane = await laneOf(server, run.id, done.id);
    expect(status).toEqual({
      runId: run.id,
      name: "status",
      state: "running",
      lanes: [
        {
          id: done.id,
          name: "done",
          wave: 1,
          state: "passed",
          workspace: (await workspaceOf(server, doneLane.workspaceId as string)).name,
          stage: "implement",
          round: 1,
          diff: `runs/${run.id}/lanes/${done.id}.diff`,
        },
        {
          id: stuck.id,
          name: "stuck",
          wave: 1,
          state: "running",
          workspace: (await workspaceOf(server, started.workspaceId as string)).name,
          stage: "gates",
          blocked: blocked.blocked,
        },
      ],
    });

    const asLane = await asAgent(
      server,
      worker.agentId,
      started.workspaceId as string,
    )("GET", `run-status/${run.id}`);
    expect((await json<{ status: RunStatus }>(asLane)).status.runId).toBe(run.id);

    const other = await createRun(server, projectId, "other");
    const refused = await asAgent(
      server,
      other.run.coordinatorAgentId,
      other.run.workspaceId,
    )("GET", `run-status/${run.id}`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "not_in_run" } });
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

const newWorkerChat = async (server: TestServer, workspaceId: string) =>
  (
    await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
      201,
    )
  ).agent.id;
/** A chat that works cannot be replaced (409 worker_busy), so the tests stop the coordinator first. */
const stopped = async (server: TestServer, agentId: string) => {
  await json(await server.request("POST", `/api/agents/${agentId}/stop`));
};

describe("a new coordinator chat (ADR 0030)", () => {
  const isAsked = (message: string) =>
    message.startsWith("user: ") && message.includes("asks (question");
  const pendingOf = (server: TestServer, agentId: string) =>
    server.store
      .all<{ message: string }>(
        "SELECT message FROM agents_deliveries WHERE agent_id = ? AND state = 'pending' ORDER BY created_at, id",
        agentId,
      )
      .map((row) => row.message);

  it("becomes the coordinator, gets a handover of the whole run, and launches with the coordinator tools", async () => {
    const server = await start();
    const { projectId } = await project(server, "handover");
    const { run, coordinator } = await createRun(server, projectId, "handover");
    const { lane, asWorker } = await laneWithWorker(server, run, coordinator);
    const later = await startLane(run, coordinator, "later", { wave: 2 });
    const { question } = await json<{ question: { id: string } }>(
      await asWorker("POST", "coordinator/questions", { question: "Which hash?" }),
      201,
    );
    await untilDelivered(server, run.coordinatorAgentId, question.id);
    await stopped(server, run.coordinatorAgentId);

    const chatId = await newWorkerChat(server, run.workspaceId);

    expect((await getRun(server, run.id)).coordinatorAgentId).toBe(chatId);
    const handover = await deliveredWith(server, chatId, "coordinator of the run");
    expect(handover).toContain("new chat");
    expect(handover).toContain(run.line);
    expect(handover).toContain(run.base);
    expect(handover).toContain(`"asker" (${lane.id}), wave 1, running, brief briefs/asker.md`);
    expect(handover).toContain(`"later" (${later.id}), wave 2, waiting, brief briefs/later.md`);
    expect(handover).toContain(`${question.id}: lane "asker" asks: Which hash?`);
    expect(handover).toContain("answer_lane");
    await until(() => launchOf(chatId) !== undefined);
    expect(launchOf(chatId)?.env.PI_SPORE_RUN_ROLE).toBe("coordinator");
    expect(launchOf(chatId)?.env.PI_SPORE_RUN_ID).toBe(run.id);
    expect(launchOf(chatId)?.argv.join(" ")).toContain(COORDINATOR_TOOLS.join(","));
  });

  it("lists the diff of a passed lane", async () => {
    const server = await start();
    const { projectId } = await project(server, "handover-diff");
    const { run, coordinator } = await createRun(server, projectId, "handover-diff");
    const started = await startLane(run, coordinator, "done");
    await passLane(server, run.id, started.id);
    await untilDelivered(server, run.coordinatorAgentId, "passed its pipeline");
    await stopped(server, run.coordinatorAgentId);

    const chatId = await newWorkerChat(server, run.workspaceId);

    const handover = await deliveredWith(server, chatId, "coordinator of the run");
    expect(handover).toContain(
      `"done" (${started.id}), wave 1, passed, brief briefs/done.md, diff runs/${run.id}/lanes/${started.id}.diff`,
    );
  });

  // Pi cannot start, so the questions stay pending on the coordinator that never took them.
  it("moves the deliveries the old chat has not taken to the new chat, after the handover", async () => {
    const server = await start();
    const { projectId } = await project(server, "handover-queue");
    const { run, coordinator } = await createRun(server, projectId, "handover-queue");
    const { asWorker } = await laneWithWorker(server, run, coordinator);
    writeFileSync(PI_DOWN(), "");
    await asWorker("POST", "coordinator/questions", { question: "First?" });
    await asWorker("POST", "coordinator/questions", { question: "Second?" });
    await until(() => pendingOf(server, run.coordinatorAgentId).length === 2);

    const chatId = await newWorkerChat(server, run.workspaceId);

    expect(pendingOf(server, run.coordinatorAgentId)).toEqual([]);
    expect(pendingOf(server, chatId)).toHaveLength(3);
    rmSync(PI_DOWN());
    await json(await server.request("POST", `/api/workspaces/${run.workspaceId}/park`));
    await json(await server.request("POST", `/api/workspaces/${run.workspaceId}/resume`));
    // The handover also quotes the open questions, so the moved messages are told apart by their own wording.
    await until(async () => (await chat(server, chatId)).filter(isAsked).length === 2);
    const messages = await chat(server, chatId);
    const at = (text: string) => messages.findIndex((message) => message.includes(text));
    expect(at("coordinator of the run")).toBe(0);
    expect(messages.findIndex(isAsked)).toBeGreaterThan(0);
    expect(messages.filter(isAsked).map((message) => message.includes("First?"))).toEqual([
      true,
      false,
    ]);
  });

  it("gets the report of a lane that passes after the change, not the old chat", async () => {
    const server = await start();
    const { projectId } = await project(server, "handover-report");
    const { run, coordinator } = await createRun(server, projectId, "handover-report");
    const started = await startLane(run, coordinator, "work");
    await until(async () => (await laneOf(server, run.id, started.id)).state === "running");
    const chatId = await newWorkerChat(server, run.workspaceId);

    await passLane(server, run.id, started.id);

    const report = await deliveredWith(server, chatId, "passed its pipeline");
    expect(report).toContain(started.id);
    expect(await chat(server, run.coordinatorAgentId)).toEqual([]);
  });

  it("makes an older chat the coordinator when the user activates it", async () => {
    const server = await start();
    const { projectId } = await project(server, "handover-activate");
    const { run } = await createRun(server, projectId, "handover-activate");
    const second = await newWorkerChat(server, run.workspaceId);
    expect((await getRun(server, run.id)).coordinatorAgentId).toBe(second);
    await untilDelivered(server, second, "coordinator of the run");
    await stopped(server, second);

    await json(await server.request("POST", `/api/agents/${run.coordinatorAgentId}/activate`));

    expect((await getRun(server, run.id)).coordinatorAgentId).toBe(run.coordinatorAgentId);
  });

  it("keeps the coordinator of a cancelled run", async () => {
    const server = await start();
    const { projectId } = await project(server, "handover-cancelled");
    const { run } = await createRun(server, projectId, "handover-cancelled");
    await json(await server.request("POST", `/api/runs/${run.id}/cancel`));

    const chatId = await newWorkerChat(server, run.workspaceId);

    expect(chatId).not.toBe(run.coordinatorAgentId);
    expect((await getRun(server, run.id)).coordinatorAgentId).toBe(run.coordinatorAgentId);
    expect(pendingOf(server, chatId)).toEqual([]);
  });
});

describe("the run PR (ADR 0100, ADR 0130)", () => {
  const GREEN = { check: "pass", test: "pass" };
  const ghCalls = () =>
    (JSON.parse(readFileSync(ghState(), "utf8")) as { calls?: string[][] }).calls ?? [];
  const prCreates = () => ghCalls().filter((call) => call[0] === "pr" && call[1] === "create");
  const remoteHas = (origin: string, line: string) => git(origin, "branch", "--list", line) !== "";
  const decide = (server: TestServer, id: string, action: "approve" | "decline", body: object) =>
    server.request("POST", `/api/attention/approvals/${id}/${action}`, body);

  /** A run whose only lane is merged with green gates, in a project that has a bare `origin` for the push. */
  async function mergedRun(
    name: string,
    options: { withoutGithubPr?: boolean; gates?: Record<string, string> } = {},
  ) {
    const server = await start(options);
    const { projectId, folder } = await project(server, name, options.gates ?? GREEN);
    const origin = join(scratch, `${name}-origin.git`);
    git(scratch, "init", "-q", "--bare", origin);
    git(folder, "remote", "add", "origin", origin);
    git(folder, "push", "-q", "origin", "main");
    const { run, coordinator } = await createRun(server, projectId, name);
    const lane = await startLane(run, coordinator, "only");
    await laneChanges(server, run, lane.id, "feature.txt", "x\n");
    await runs.mergeLane(coordinator, { laneId: lane.id });
    await until(async () => (await laneOf(server, run.id, lane.id)).state === "merged");
    return { server, run, coordinator, origin, lane, folder };
  }

  it("files one run-pr approval and opens nothing until the user approves", async () => {
    const { server, run, coordinator, origin } = await mergedRun("pr-file");

    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "All lanes merged." });

    expect(await openApprovals(server)).toEqual([
      expect.objectContaining({
        id: filed.id,
        kind: "run-pr",
        agentId: run.coordinatorAgentId,
        subject: {
          runId: run.id,
          title: "Ship it",
          body: "All lanes merged.",
          base: "main",
          head: run.line,
        },
      }),
    ]);
    expect(ghCalls()).toEqual([]);
    expect(remoteHas(origin, run.line)).toBe(false);
  });

  it("opens the PR once on approve, with the edited title, and finishes the run", async () => {
    const { server, run, coordinator, origin } = await mergedRun("pr-approve");
    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "All lanes merged." });

    await json(
      await decide(server, filed.id, "approve", {
        subject: { ...(filed.subject as RunPrSubject), title: "Edited" },
      }),
    );

    expect(prCreates()).toEqual([
      [
        "pr",
        "create",
        "--base=main",
        `--head=${run.line}`,
        "--title=Edited",
        "--body=All lanes merged.",
      ],
    ]);
    expect(remoteHas(origin, run.line)).toBe(true);
    expect((await getRun(server, run.id)).state).toBe("finished");
    const outcome = await deliveredWith(server, run.coordinatorAgentId, "Opened PR #1");
    expect(outcome).toContain(`from ${run.line} into main`);
    expect(outcome).toContain("never turns on auto-merge");
  });

  // The PR of a finished run can need more work, such as a conflict with its base. The chat the user starts for it
  // becomes the coordinator, so a lane's report reaches a chat that runs.
  it("hands a finished run to a new chat, which gets one report of a lane that failed its gate", async () => {
    const { server, run, coordinator } = await mergedRun("pr-more", {
      gates: { ...GREEN, lint: "fail" },
    });
    writeFileSync(join(server.paths.root, "pipelines", "lint.toml"), LINT_PIPELINE);
    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "" });
    await json(await decide(server, filed.id, "approve", {}));
    await deliveredWith(server, run.coordinatorAgentId, "Opened PR #1");
    await stopped(server, run.coordinatorAgentId);

    const chatId = await newWorkerChat(server, run.workspaceId);

    expect(await getRun(server, run.id)).toMatchObject({
      state: "finished",
      coordinatorAgentId: chatId,
    });
    expect(await deliveredWith(server, chatId, "coordinator of the run")).toContain(
      "Its PR is open.",
    );
    const lane = await startLane(
      run,
      { agentId: chatId, workspaceId: run.workspaceId },
      "conflicts",
      { pipeline: "lint" },
    );
    await until(async () => (await laneOf(server, run.id, lane.id)).state === "running");
    const worker = await laneWorker(server, await laneOf(server, run.id, lane.id));
    await json(
      await asAgent(server, worker.agentId, lane.workspaceId as string)("POST", "reports", {
        turn: worker.turnId,
        summary: "Done",
      }),
    );

    const report = await deliveredWith(server, chatId, "failed its pipeline");
    expect(report).toContain(`"conflicts" (${lane.id})`);
    expect(report).toContain("gate lint failed");
    expect(report).toContain("gate output: boom");
    expect(report).toContain("revise_lane");
    await until(() => laneJob(server, lane.id).state === "done");
    // The fake agent echoes each message, so only the user lines count.
    const reports = (await chat(server, chatId)).filter(
      (line) => line.startsWith("user: ") && line.includes("failed its pipeline"),
    );
    expect(reports).toHaveLength(1);
    expect(await laneOf(server, run.id, lane.id)).toMatchObject({ state: "failed" });
  });

  /** A run whose PR is open, with a new chat as its coordinator and a second lane that passed. */
  async function finishedRunWithLane(name: string) {
    const { server, run, coordinator, origin, folder } = await mergedRun(name);
    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "" });
    await json(await decide(server, filed.id, "approve", {}));
    await deliveredWith(server, run.coordinatorAgentId, "Opened PR #1");
    await stopped(server, run.coordinatorAgentId);
    const chatId = await newWorkerChat(server, run.workspaceId);
    const caller = { agentId: chatId, workspaceId: run.workspaceId };
    const lane = await startLane(run, caller, "more");
    await laneChanges(server, run, lane.id, "more.txt", "more\n");
    return { server, run, chatId, caller, origin, lane, folder };
  }

  // ADR 0165: the user approved this branch on GitHub when they approved the PR, so pi-spore pushes each green merge.
  it("pushes a lane merged into a finished run to its open PR, and does not ask for open_run_pr", async () => {
    const { server, run, chatId, caller, origin, lane, folder } =
      await finishedRunWithLane("pr-push");

    await runs.mergeLane(caller, { laneId: lane.id });

    const delivery = await deliveredWith(server, chatId, `"more" (${lane.id}) is merged`);
    expect(git(origin, "rev-parse", run.line)).toBe(git(folder, "rev-parse", run.line));
    expect(git(origin, "show", `${run.line}:more.txt`)).toBe("more");
    expect(delivery).toContain(`pushed ${run.line}`);
    expect(delivery).toContain("PR is open");
    expect(delivery).not.toContain("open_run_pr");
    expect(prCreates()).toHaveLength(1);
    expect(git(folder, "rev-parse", "main")).toBe(git(origin, "rev-parse", "main"));
  });

  it("keeps the lane merged and tells the coordinator when the push to the open PR fails", async () => {
    const { server, run, chatId, caller, origin, lane } = await finishedRunWithLane("pr-push-fail");
    const other = join(scratch, "pr-push-fail-other");
    git(scratch, "clone", "-q", "--branch", run.line, origin, other);
    git(other, "commit", "-q", "--allow-empty", "-m", "someone else");
    git(other, "push", "-q", "origin", run.line);
    const remoteHead = git(origin, "rev-parse", run.line);

    await runs.mergeLane(caller, { laneId: lane.id });

    const delivery = await deliveredWith(server, chatId, `"more" (${lane.id}) is merged`);
    expect(delivery).toContain(`could not push ${run.line}`);
    expect(delivery).toContain("push_failed");
    expect(delivery).not.toContain("open_run_pr");
    expect(await laneOf(server, run.id, lane.id)).toMatchObject({ state: "merged" });
    expect(git(origin, "rev-parse", run.line)).toBe(remoteHead);
  });

  it("answers 409 pr_not_supported on approve without the github-pr module, and the approval stays open", async () => {
    const { server, coordinator } = await mergedRun("pr-no-module", { withoutGithubPr: true });
    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "" });

    const response = await decide(server, filed.id, "approve", {});

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "pr_not_supported" } });
    expect((await openApprovals(server)).map((approval) => approval.id)).toEqual([filed.id]);
  });

  it("refuses a second request while one is open with 409 run_pr_asked", async () => {
    const { coordinator } = await mergedRun("pr-twice");
    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "" });

    expect(() => runs.requestPr(coordinator, { title: "Again", body: "" })).toThrow(
      expect.objectContaining({ status: 409, code: "run_pr_asked" }),
    );
    expect(() => runs.requestPr(coordinator, { title: "Again", body: "" })).toThrow(filed.id);
  });

  it("refuses a run with a lane that is not merged or declined with 409 run_not_finished", async () => {
    const server = await start();
    const { projectId } = await project(server, "pr-early", GREEN);
    const { run, coordinator } = await createRun(server, projectId, "pr-early");

    expect(() => runs.requestPr(coordinator, { title: "x", body: "" })).toThrow(
      expect.objectContaining({
        status: 409,
        code: "run_not_finished",
        message: expect.stringContaining("No lane is merged yet"),
      }),
    );
    const lane = await startLane(run, coordinator, "early");
    await laneChanges(server, run, lane.id, "feature.txt", "x\n");

    expect(() => runs.requestPr(coordinator, { title: "x", body: "" })).toThrow(
      expect.objectContaining({
        status: 409,
        code: "run_not_finished",
        message: expect.stringContaining(`"early" (${lane.id}) is passed`),
      }),
    );
    expect(await openApprovals(server)).toEqual([]);
  });

  it("gives the coordinator the decline note, opens nothing, and lets it ask again", async () => {
    const { server, run, coordinator, origin } = await mergedRun("pr-decline");
    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "" });

    await json(await decide(server, filed.id, "decline", { note: "Reword the title" }));

    const note = await deliveredWith(server, run.coordinatorAgentId, "The user declined");
    expect(note).toContain("Reword the title");
    expect(ghCalls()).toEqual([]);
    expect(remoteHas(origin, run.line)).toBe(false);
    expect((await getRun(server, run.id)).state).toBe("running");
    expect(runs.requestPr(coordinator, { title: "Better", body: "" }).id).not.toBe(filed.id);
  });

  it("keeps the approval open when approve changes the head, with 422 approval_run_changed", async () => {
    const { server, coordinator } = await mergedRun("pr-head");
    const filed = runs.requestPr(coordinator, { title: "Ship it", body: "" });

    const response = await decide(server, filed.id, "approve", {
      subject: { ...(filed.subject as RunPrSubject), head: "main" },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "approval_run_changed" } });
    expect((await openApprovals(server)).map((approval) => approval.id)).toEqual([filed.id]);
    expect(ghCalls()).toEqual([]);
  });
});

describe("cards from a run's coordinator (ADR 0154)", () => {
  it("adds a card to the run's project in backlog with a from-run label, and lists only that project", async () => {
    const server = await start();
    const { projectId } = await project(server, "cards");
    const other = await project(server, "elsewhere");
    const { run, coordinator } = await createRun(server, projectId, "Settings Page");
    const foreign = (
      await json<{ card: { id: string } }>(
        await server.request("POST", "/api/kanban/cards", {
          title: "Not yours",
          projectId: other.projectId,
        }),
        201,
      )
    ).card;
    const call = asAgent(server, coordinator.agentId, coordinator.workspaceId);

    const { card } = await json<{ card: { id: string; labels: string[]; column: string } }>(
      await call("POST", "cards", {
        title: "Flaky staged comments test",
        body: "Why, steps, check",
        labels: ["plan:settings"],
        column: "ready",
      }),
      201,
    );

    expect(card.labels).toEqual(["plan:settings", "from-run:settings-page"]);
    expect(card.column).toBe("backlog");
    const { cards } = await json<{ cards: { id: string }[] }>(await call("GET", "cards"));
    expect(cards.map((entry) => entry.id)).toEqual([card.id]);
    expect(cards.map((entry) => entry.id)).not.toContain(foreign.id);
    expect(
      (
        await json<{ card: { projectId: string } }>(
          await server.request("GET", `/api/kanban/cards/${card.id}`),
        )
      ).card.projectId,
    ).toBe(run.projectId);
  });

  it("answers 403 when the coordinator changes or starts a card", async () => {
    const server = await start();
    const { projectId } = await project(server, "no-change");
    const { coordinator } = await createRun(server, projectId, "nochange");
    const call = asAgent(server, coordinator.agentId, coordinator.workspaceId);
    const { card } = await json<{ card: { id: string } }>(
      await call("POST", "cards", { title: "Follow-up" }),
      201,
    );

    const change = await call("POST", `cards/${card.id}`, { title: "Renamed" });
    const begin = await call("POST", `cards/${card.id}/start`, {
      target: { kind: "new", isolation: "new" },
      reason: "Go",
    });

    for (const response of [change, begin]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "run_coordinator" } });
    }
    expect(await openApprovals(server)).toEqual([]);
  });
});

describe("revising a lane (ADR 0158)", () => {
  const GREEN = { check: "pass", test: "pass" };
  const FINDING = { severity: "important", title: "Missing null check", file: "a.txt", line: 2 };
  const DONE = { summary: "Done" };
  const FIX = { summary: "Fixed" };
  const LOOKS_FINE = { summary: "Looks fine", verdict: "approve", findings: [FINDING] };
  const APPROVE = { summary: "Good", verdict: "approve" };
  const REVISE = { summary: "Still wrong", verdict: "revise", findings: [FINDING] };
  /** Implement, then one review round, so the lane's first run leaves a review for the revise to show. */
  const REVIEWED = `id = "rv"\n\n[[stage]]\nname = "implement"\nrole = "worker"\n\n[[stage]]\nname = "review"\nrole = "reviewer"\nrounds = 1\n`;

  /** A lane whose first run passed, and a way to revise it that returns the revise's pipeline run. */
  async function passedLane(
    name: string,
    script: Record<string, unknown[]>,
    gates: Record<string, string> = GREEN,
  ) {
    const server = await start({ script });
    writeFileSync(join(server.paths.root, "pipelines", "rv.toml"), REVIEWED);
    const { projectId } = await project(server, name, gates);
    const { run, coordinator } = await createRun(server, projectId, name);
    const started = await startLane(run, coordinator, "feature", { pipeline: "rv" });
    const untilLane = (state: Lane["state"]) =>
      until(async () => (await laneOf(server, run.id, started.id)).state === state);
    await untilLane("passed");
    const lane = await laneOf(server, run.id, started.id);
    const pipelineRuns = async () =>
      (
        await json<{ runs: PipelineRun[] }>(
          await server.request("GET", `/api/pipelines/workspaces/${lane.workspaceId}/runs`),
        )
      ).runs;
    const [first] = (await pipelineRuns()) as [PipelineRun];
    const laneAgents = async () =>
      (
        await json<{ agents: { id: string; role: string }[] }>(
          await server.request("GET", `/api/agents?workspaceId=${lane.workspaceId}`),
        )
      ).agents;
    const ofRole = async (role: string) =>
      (await laneAgents()).filter((agent) => agent.role === role).map((agent) => agent.id);
    const revise = async () => {
      await artifacts.write(
        { scope: "workspace", id: run.workspaceId },
        "briefs/fix.md",
        "Fix the null check",
      );
      await runs.reviseLane(coordinator, { laneId: lane.id, brief: "briefs/fix.md" });
      let revised: PipelineRun | undefined;
      // The run row comes first; its first stage step gives it a worker and a task turn later.
      await until(async () => {
        revised = (await pipelineRuns()).find((entry) => entry.id !== first.id);
        return revised?.workerAgentId !== undefined;
      });
      return revised as PipelineRun;
    };
    const coordinatorSaid = async (text: string) =>
      // The fake Pi echoes each prompt, so only the user side counts.
      (await chat(server, run.coordinatorAgentId)).filter(
        (message) => message.startsWith("user:") && message.includes(text),
      );
    return { server, run, lane, first, revise, untilLane, ofRole, pipelineRuns, coordinatorSaid };
  }

  it("gives the brief to the lane's own worker, with one new reviewer and no new worker", async () => {
    const { first, revise, untilLane, ofRole } = await passedLane("reuse", {
      worker: [DONE, FIX],
      reviewer: [LOOKS_FINE, APPROVE],
    });
    const reviewers = await ofRole("reviewer");

    const revised = await revise();
    await untilLane("passed");

    expect(revised.pipelineId).toBe("revise");
    expect(revised.workerAgentId).toBe(first.workerAgentId);
    expect(revised.turns[0]).toMatchObject({ kind: "task", agentId: first.workerAgentId });
    expect(await ofRole("worker")).toEqual([first.workerAgentId]);
    expect((await ofRole("reviewer")).length).toBe(reviewers.length + 1);
    expect(await ofRole("adversarial-reviewer")).toEqual([]);
  });

  it("shows the reviewer the previous findings and the fix diff", async () => {
    const { server, revise, untilLane, pipelineRuns } = await passedLane("findings", {
      worker: [DONE, FIX],
      reviewer: [LOOKS_FINE, APPROVE],
    });

    const revised = await revise();
    await untilLane("passed");

    const done = (await pipelineRuns()).find((entry) => entry.id === revised.id) as PipelineRun;
    const prompt = (await chat(server, (done.turns[1] as { agentId: string }).agentId))[0];
    expect(prompt).toContain("1. [important] Missing null check (a.txt:2)");
    expect(prompt).toContain(`pipelines/${revised.id}/review-1-fix.diff`);
  });

  it("passes the lane after an approve and green gates, and tells the coordinator", async () => {
    const { revise, untilLane, coordinatorSaid } = await passedLane("approve", {
      worker: [DONE, FIX],
      reviewer: [LOOKS_FINE, APPROVE],
    });

    await revise();
    await untilLane("passed");

    await until(async () => (await coordinatorSaid("passed its pipeline")).length === 2);
    expect(await coordinatorSaid("worker chat is gone")).toEqual([]);
  });

  it("makes one last fix after a REVISE, with no second reviewer and no approval", async () => {
    const { server, first, revise, untilLane, ofRole } = await passedLane("lastfix", {
      worker: [DONE, FIX, FIX],
      reviewer: [LOOKS_FINE, REVISE],
    });
    const reviewers = await ofRole("reviewer");

    await revise();
    await untilLane("passed");

    expect((await ofRole("reviewer")).length).toBe(reviewers.length + 1);
    expect(await ofRole("worker")).toEqual([first.workerAgentId]);
    expect(await openApprovals(server)).toEqual([]);
  });

  it("fails the lane on a red gate and tells the coordinator", async () => {
    const { revise, untilLane, coordinatorSaid } = await passedLane(
      "redgate",
      { worker: [DONE, FIX], reviewer: [LOOKS_FINE, APPROVE] },
      { check: "pass", test: "fail" },
    );

    await revise();
    await untilLane("failed");

    await until(async () => (await coordinatorSaid("failed its pipeline")).length === 1);
  });

  it("runs the lane's own pipeline with a new worker when its worker chat is closed", async () => {
    const { server, run, lane, first, revise, untilLane } = await passedLane("closed", {
      worker: [DONE, DONE],
      reviewer: [LOOKS_FINE, APPROVE],
    });
    // A chat that is still working refuses the close with 409.
    await until(
      async () =>
        (await server.request("POST", `/api/agents/${first.workerAgentId}/close`)).status === 200,
    );

    const revised = await revise();
    await untilLane("passed");

    expect(revised.pipelineId).toBe("rv");
    expect(revised.workerAgentId).toBeDefined();
    expect(revised.workerAgentId).not.toBe(first.workerAgentId);
    const gone = await deliveredWith(server, run.coordinatorAgentId, "worker chat is gone");
    expect(gone).toContain(`Lane "feature" (${lane.id})`);
    expect(gone).toContain('"rv"');
  });
});
