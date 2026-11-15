import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { type Artifacts, ArtifactsKey, artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { bridgeModule } from "@pi-spore/mod-bridge/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { type Runs, RunsKey, runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { BridgeCaller, ServerModule } from "@pi-spore/module-api";
import { createTestServer, TEST_TOKEN, type TestServer } from "@pi-spore/server-core/testing";
import type {
  AgentGraph,
  AgentGraphEvent,
  GraphTree,
  PipelineRun,
  PipelineTurn,
  Run,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentGraphModule, GRAPH_TOPIC } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let scratch: string;
let servers: { server: TestServer; agents: ReturnType<typeof createAgentsModule> }[];
let runs: Runs;
let artifacts: Artifacts;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-agent-graph-")));
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

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A module that hands the tests the interfaces a coordinator's bridge calls use. */
const probe: ServerModule = {
  id: "graph-probe",
  requires: ["runs", "artifacts"],
  core: false,
  setup(host) {
    runs = host.use(RunsKey);
    artifacts = host.use(ArtifactsKey);
  },
};

const IMPLEMENT = `id = "p"

[[stage]]
name = "implement"
role = "worker"
tier = "route"
`;

const WITH_REVIEW = `${IMPLEMENT}\n[[stage]]\nname = "review"\nrole = "reviewer"\n`;

const DONE = { summary: "Done", tests: [{ name: "adds", proof: "proofs/adds.md" }] };

const DAY = 86_400_000;
const START = 1_700_000_000_000;

/**
 * A server with the fake Pi; `script` is what each stage role answers (see fake-pi.mjs). Its home is a folder, so a
 * second server on the same `home` acts as a restart; `days` later than the first, chats closed before are past
 * retention (30 days).
 */
async function start(
  script: Record<string, unknown[]>,
  pipeline = IMPLEMENT,
  restart?: { home: string; days: number },
) {
  const home = restart?.home ?? realpathSync(mkdtempSync(join(scratch, "home-")));
  mkdirSync(join(home, "pipelines"), { recursive: true });
  writeFileSync(join(home, "pipelines", "p.toml"), pipeline);
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ tiers: { "fake/mid": "medium" }, retention: { days: 30 } }),
  );
  const file = join(scratch, "script.json");
  writeFileSync(file, JSON.stringify(script));
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({ provider: "fake", modelId: "mid" }),
    baseEnv: { PATH: process.env.PATH, FAKE_PI_SCRIPT: file },
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
      agentGraphModule,
      probe,
    ],
    {
      listen: true,
      home,
      startAt: START + (restart?.days ?? 0) * DAY,
      ...(restart ? { firstId: 1_000 } : {}),
    },
  );
  servers.push({ server, agents });
  return server;
}

/** Stops the newest server, so the next `start` on its home is a restart. */
async function stop() {
  const last = servers.pop();
  last?.server.services.jobs.stop();
  await last?.agents.manager().stopAll();
  last?.server.close();
}

/** A folder project with one in-place workspace and its worker chat. */
async function workspace(server: TestServer, name: string) {
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
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
  return { workspaceId: workspace.id, agentId: agent.id };
}

/** A git project on `main` with one commit, for a run and its lane worktrees. */
async function gitProject(server: TestServer, name: string) {
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
  writeFileSync(join(folder, "a.txt"), "one\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: folder });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  return project.id;
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

/** Writes a brief into the run workspace and starts a lane on it. */
async function startLane(run: Run, coordinator: BridgeCaller, name: string) {
  const brief = `briefs/${name}.md`;
  await artifacts.write({ scope: "workspace", id: run.workspaceId }, brief, `Build ${name}`);
  return runs.startLane(coordinator, { name, brief, wave: 1, pipeline: "p" });
}

const getRun = async (server: TestServer, id: string) =>
  (await json<{ run: Run }>(await server.request("GET", `/api/runs/${id}`))).run;
const getPipelineRun = async (server: TestServer, id: string) =>
  (await json<{ run: PipelineRun }>(await server.request("GET", `/api/pipelines/runs/${id}`))).run;
const graph = async (server: TestServer) =>
  (await json<AgentGraph>(await server.request("GET", "/api/agent-graph"))).trees;
const events = (server: TestServer) => server.events.eventsOf(GRAPH_TOPIC) as AgentGraphEvent[];
const startRun = async (server: TestServer, workspaceId: string) =>
  (
    await json<{ run: PipelineRun }>(
      await server.request("POST", `/api/pipelines/workspaces/${workspaceId}/runs`, {
        pipeline: "p",
        brief: "Build the thing",
      }),
      201,
    )
  ).run;
const prompt = (server: TestServer, agentId: string, message: string) =>
  server.request("POST", `/api/agents/${agentId}/prompt`, { message });
const savePosition = (server: TestServer, node: string, x: number, y: number) =>
  server.request("PUT", "/api/agent-graph/positions", { node, x, y });
/** The saved rows, since an archived workspace's tree is out of the graph, so GET cannot show its rows are gone. */
const positionRows = (server: TestServer) =>
  server.store
    .all<{ workspace_id: string; node_id: string }>(
      "SELECT workspace_id, node_id FROM agent_graph_positions ORDER BY node_id",
    )
    .map((row) => `${row.workspace_id} ${row.node_id}`);

describe("the agent graph (ADR 0176)", () => {
  it("gives a run one tree with its coordinator and one group per lane, and the lanes no tree", async () => {
    const server = await start({ worker: ["hang", "hang"] });
    const projectId = await gitProject(server, "graph-run");
    const { run, coordinator } = await createRun(server, projectId, "graph");
    const one = await startLane(run, coordinator, "one");
    const two = await startLane(run, coordinator, "two");
    await until(async () =>
      (await getRun(server, run.id)).lanes.every((lane) => lane.pipelineRunId !== undefined),
    );

    const trees = await graph(server);

    expect(trees).toHaveLength(1);
    const [tree] = trees as [GraphTree];
    expect(tree).toMatchObject({
      kind: "run",
      runId: run.id,
      workspaceId: run.workspaceId,
      projectId,
      root: { agentId: run.coordinatorAgentId, workspaceId: run.workspaceId },
    });
    const lanes = (await getRun(server, run.id)).lanes;
    expect(
      tree.groups.map(({ laneId, workspaceId, stage }) => ({ laneId, workspaceId, stage })),
    ).toEqual([
      { laneId: one.id, workspaceId: lanes[0]?.workspaceId, stage: "implement" },
      { laneId: two.id, workspaceId: lanes[1]?.workspaceId, stage: "implement" },
    ]);
  });

  it("gives a workspace its worker chat and a run in review with a done and a running step", async () => {
    const server = await start({ worker: [DONE], reviewer: ["hang"] }, WITH_REVIEW);
    const { workspaceId, agentId } = await workspace(server, "review");
    const run = await startRun(server, workspaceId);
    await until(async () => (await getPipelineRun(server, run.id)).turns.length === 2);
    const [task, review] = (await getPipelineRun(server, run.id)).turns as [
      PipelineTurn,
      PipelineTurn,
    ];

    const trees = await graph(server);

    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({
      kind: "workspace",
      workspaceId,
      root: { agentId, kind: "worker", role: "orchestrator" },
      groups: [
        {
          pipelineRunId: run.id,
          name: "p",
          state: "running",
          stage: "review",
          round: 1,
          live: true,
          steps: [
            {
              id: task.id,
              stage: "implement",
              kind: "task",
              round: 1,
              state: "done",
              agent: { agentId: task.agentId, kind: "stage", role: "worker" },
            },
            {
              id: review.id,
              stage: "review",
              kind: "review",
              round: 1,
              state: "running",
              agent: { agentId: review.agentId, kind: "stage", role: "reviewer" },
            },
          ],
        },
      ],
    });
  });

  it("shows a running helper on its agent, then once as done, then not at all", async () => {
    const server = await start({});
    const { agentId } = await workspace(server, "helpers");
    const rootHelpers = (trees: GraphTree[] | undefined) => trees?.[0]?.root.helpers;

    await json(await prompt(server, agentId, "helper:run-1:scout:running"));
    await until(async () => rootHelpers(await graph(server))?.length === 1);
    expect(rootHelpers(await graph(server))).toEqual([
      {
        id: "run-1:0",
        agent: "scout",
        model: "fake/helper-model",
        state: "running",
      },
    ]);
    await until(() => rootHelpers(events(server).at(-1)?.trees)?.length === 1);

    const mark = events(server).length;
    await json(await prompt(server, agentId, "helper:run-1:scout:complete"));
    const ended = () =>
      events(server).findIndex(
        (event, index) =>
          index >= mark && rootHelpers(event.trees)?.some((helper) => helper.state === "done"),
      );
    await until(() => ended() !== -1);
    expect(rootHelpers(events(server)[ended()]?.trees)).toEqual([
      expect.objectContaining({ id: "run-1:0", agent: "scout", state: "done" }),
    ]);
    await until(() => events(server).length > ended() + 1);
    expect(rootHelpers(events(server)[ended() + 1]?.trees)).toEqual([]);
    expect(rootHelpers(await graph(server))).toEqual([]);
  });

  it("drops an archived workspace's tree from GET and from the next event", async () => {
    const server = await start({});
    const { workspaceId } = await workspace(server, "archived");
    expect((await graph(server)).map((tree) => tree.workspaceId)).toEqual([workspaceId]);

    const mark = events(server).length;
    await json(await server.request("POST", `/api/workspaces/${workspaceId}/archive`, {}));

    expect(await graph(server)).toEqual([]);
    await until(() => events(server).length > mark && events(server).at(-1)?.trees.length === 0);
  });

  it("ends every member of the group a stopped run was in, not only the first (ADR 0178)", async () => {
    // The adversarial reviewer's model is too weak, so the group blocks before any member has a turn.
    const grouped = `${WITH_REVIEW}\n[[stage]]\nname = "adversarial"\nrole = "reviewer"\nwith_previous = true\nmodel = "fake/weak"\nmin_strength_over = "implement"\n`;
    const server = await start({ worker: [DONE] }, grouped);
    const { workspaceId } = await workspace(server, "group");
    const run = await startRun(server, workspaceId);
    await until(async () => (await getPipelineRun(server, run.id)).blocked !== undefined);
    await json(await server.request("POST", `/api/pipelines/runs/${run.id}/cancel`));

    const [tree] = (await graph(server)) as [GraphTree];
    expect(tree.groups[0]?.steps.map(({ stage, state }) => ({ stage, state }))).toEqual([
      { stage: "implement", state: "done" },
      { stage: "review", state: "failed" },
      { stage: "adversarial", state: "failed" },
    ]);
  });

  it("keeps a step whose stage chat retention deleted, without its agent", async () => {
    const first = await start({ worker: [DONE] });
    const { workspaceId } = await workspace(first, "retained");
    const run = await startRun(first, workspaceId);
    await until(async () => (await getPipelineRun(first, run.id)).state === "passed");
    const [task] = (await getPipelineRun(first, run.id)).turns as [PipelineTurn];
    await until(
      async () =>
        (
          await json<{ agent: { status: string } }>(
            await first.request("GET", `/api/agents/${task.agentId}`),
          )
        ).agent.status === "idle",
    );
    await json(await first.request("POST", `/api/agents/${task.agentId}/close`));
    const home = first.paths.root;
    await stop();

    const server = await start({}, IMPLEMENT, { home, days: 31 });
    await until(
      async () => (await server.request("GET", `/api/agents/${task.agentId}`)).status === 404,
    );

    const [tree] = (await graph(server)) as [GraphTree];
    expect(tree.groups[0]?.steps).toEqual([
      { id: task.id, stage: "implement", kind: "task", round: 1, state: "done" },
    ]);
  });

  it("publishes a new tree when a workspace gets its first worker chat", async () => {
    const server = await start({});
    const mark = events(server).length;

    const { workspaceId } = await workspace(server, "first-chat");

    await until(() =>
      events(server)
        .slice(mark)
        .some((event) => event.trees.some((tree) => tree.workspaceId === workspaceId)),
    );
  });

  it("keeps a dragged tree's place in GET and in the next event", async () => {
    const server = await start({});
    const { workspaceId } = await workspace(server, "drag-tree");
    const node = `tree:${workspaceId}`;

    expect(await json(await savePosition(server, node, 320, -60))).toEqual({ ok: true });

    const [tree] = (await graph(server)) as [GraphTree];
    expect(tree.positions).toEqual({ [node]: { x: 320, y: -60 } });
    await until(() => events(server).some((event) => event.trees[0]?.positions[node]?.x === 320));

    // Dragged again, it is one row at the newest place.
    await json(await savePosition(server, node, 80, 90));
    const [moved] = (await graph(server)) as [GraphTree];
    expect(moved.positions).toEqual({ [node]: { x: 80, y: 90 } });
    expect(positionRows(server)).toEqual([`${workspaceId} ${node}`]);
  });

  it("saves a lane step's place under the tree that shows it", async () => {
    const server = await start({ worker: ["hang", "hang"] });
    const projectId = await gitProject(server, "drag-step");
    const { run, coordinator } = await createRun(server, projectId, "drag-step");
    await startLane(run, coordinator, "one");
    await until(async () =>
      (await getRun(server, run.id)).lanes.some((lane) => lane.pipelineRunId !== undefined),
    );
    const [tree] = (await graph(server)) as [GraphTree];
    const group = tree.groups[0];
    const step = group?.steps[0];
    if (!group || !step) throw new Error("the lane's group has no step");
    const node = `step:${step.id}`;
    const groupNode = `group:${group.pipelineRunId}`;

    await json(await savePosition(server, node, 12, 8));
    await json(await savePosition(server, groupNode, 3, 4));

    const [saved] = (await graph(server)) as [GraphTree];
    expect(saved.positions).toEqual({ [node]: { x: 12, y: 8 }, [groupNode]: { x: 3, y: 4 } });
    // Both rows are under the tree's workspace, not the lane's, so archiving the run workspace clears them.
    expect(positionRows(server)).toEqual([
      `${tree.workspaceId} ${groupNode}`,
      `${tree.workspaceId} ${node}`,
    ]);
  });

  it("clears every saved place on request", async () => {
    const server = await start({});
    const one = await workspace(server, "reset-one");
    const two = await workspace(server, "reset-two");
    await json(await savePosition(server, `tree:${one.workspaceId}`, 10, 20));
    await json(await savePosition(server, `tree:${two.workspaceId}`, 30, 40));
    const mark = events(server).length;

    expect(await json(await server.request("DELETE", "/api/agent-graph/positions"))).toEqual({
      ok: true,
    });

    expect((await graph(server)).map((tree) => tree.positions)).toEqual([{}, {}]);
    await until(() => events(server).length > mark);
    expect(
      events(server)
        .at(-1)
        ?.trees.map((tree) => tree.positions),
    ).toEqual([{}, {}]);
  });

  it("deletes an archived workspace's saved places and keeps a parked one's", async () => {
    const server = await start({});
    const parked = await workspace(server, "parked-places");
    const gone = await workspace(server, "archived-places");
    await json(await savePosition(server, `tree:${parked.workspaceId}`, 5, 6));
    await json(await savePosition(server, `tree:${gone.workspaceId}`, 7, 8));

    // A parked workspace can resume, so its places stay; an archived one never comes back (ADR 0176).
    await json(await server.request("POST", `/api/workspaces/${parked.workspaceId}/park`, {}));
    expect(positionRows(server)).toEqual([
      `${parked.workspaceId} tree:${parked.workspaceId}`,
      `${gone.workspaceId} tree:${gone.workspaceId}`,
    ]);

    await json(await server.request("POST", `/api/workspaces/${gone.workspaceId}/archive`, {}));
    expect(positionRows(server)).toEqual([`${parked.workspaceId} tree:${parked.workspaceId}`]);
  });

  it("answers 400 for a saved place body that is not JSON", async () => {
    const server = await start({});
    await workspace(server, "bad-position-json");

    // `server.request` always writes JSON, so the broken bytes go to the server that already listens for the agents.
    const response = await fetch(`${server.url}/api/agent-graph/positions`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pi-spore-token": TEST_TOKEN },
      body: "{ node: tree:1, x: 1,",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("not valid JSON");
    expect(positionRows(server)).toEqual([]);
  });

  it("answers 400 for a saved place with no x, from the schema and not the node lookup", async () => {
    const server = await start({});
    const { workspaceId } = await workspace(server, "bad-position-x");

    const response = await server.request("PUT", "/api/agent-graph/positions", {
      node: `tree:${workspaceId}`,
      y: 1,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    // The node is one of the graph, so only the schema can stop it here, and it stops it before any write.
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("must have required properties x");
    expect(positionRows(server)).toEqual([]);
  });

  it.each([
    ["a helper id", "run-1:0"],
    ["a tree of no workspace", "tree:nope"],
  ])("answers 400, naming the id, for %s", async (_name, node) => {
    const server = await start({});
    const { workspaceId } = await workspace(server, "bad-position-node");
    expect((await graph(server)).map((tree) => tree.workspaceId)).toEqual([workspaceId]);

    const response = await savePosition(server, node, 1, 2);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unknown_node");
    expect(body.error.message).toContain(node);
    expect(positionRows(server)).toEqual([]);
  });

  it("shows a worker's helper on its fix step only, not on its earlier task step", async () => {
    const revise = {
      summary: "Not yet",
      verdict: "revise",
      findings: [{ severity: "important", title: "Missing check" }],
    };
    const server = await start(
      { worker: [DONE, "hang"], reviewer: [revise] },
      `${IMPLEMENT}\n[[stage]]\nname = "review"\nrole = "reviewer"\nrounds = 2\nfix_passes = 1\n`,
    );
    const { workspaceId } = await workspace(server, "fix");
    const run = await startRun(server, workspaceId);
    await until(async () => (await getPipelineRun(server, run.id)).turns.length === 3);
    const [task, , fix] = (await getPipelineRun(server, run.id)).turns as [
      PipelineTurn,
      PipelineTurn,
      PipelineTurn,
    ];
    expect(fix).toMatchObject({ kind: "fix", agentId: task.agentId });

    await json(await prompt(server, task.agentId, "helper:run-1:scout:running"));
    const steps = async () => (await graph(server))[0]?.groups[0]?.steps ?? [];
    await until(async () => (await steps()).some((step) => step.agent?.helpers.length));

    const byId = new Map((await steps()).map((step) => [step.id, step.agent?.helpers]));
    expect(byId.get(task.id)).toEqual([]);
    expect(byId.get(fix.id)).toEqual([
      expect.objectContaining({ id: "run-1:0", state: "running" }),
    ]);
  });
});
