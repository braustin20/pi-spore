import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { type AgentEvent, createAgentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type {
  BridgeArtifactFile,
  ChatState,
  PipelineList,
  PipelineRun,
  PipelineTurn,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let scratch: string;
let servers: { server: TestServer; agents: ReturnType<typeof createAgentsModule> }[];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-pipelines-")));
  servers = [];
});
afterEach(async () => {
  for (const { server, agents } of servers) {
    await agents.manager().stopAll();
    server.close();
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** The fake Pi's script (see fake-pi.mjs), and a file that records how each agent process was launched. */
function scriptEnv(script: Record<string, unknown[]>) {
  const file = join(scratch, "script.json");
  writeFileSync(file, JSON.stringify(script));
  return { FAKE_PI_SCRIPT: file, FAKE_PI_RECORD: join(scratch, "record.jsonl") };
}

/** A server with every module a pipeline run needs, the fake Pi, and a real HTTP port for it to call. */
async function start(
  options: { home?: string; firstId?: number; env?: Record<string, string> } = {},
) {
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH, ...options.env },
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
      kanbanModule,
      artifactsModule,
      pipelinesModule,
      bridgeModule,
    ],
    {
      listen: true,
      ...(options.home ? { home: options.home } : {}),
      ...(options.firstId ? { firstId: options.firstId } : {}),
    },
  );
  servers.push({ server, agents });
  return server;
}

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** A folder project with one in-place workspace and its worker chat, the chat that asks for pipeline runs. */
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

/** Calls a bridge route as an agent process would, with its own token. */
function asAgent(server: TestServer, agentId: string, workspaceId: string) {
  const token = server.agentTokens.issue({ agentId, workspaceId });
  return (method: string, path: string, body?: unknown) =>
    server.request(method, `/api/bridge/${path}`, body, {
      "x-pi-spore-token": "",
      authorization: `Bearer ${token}`,
    });
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function chat(server: TestServer, agentId: string): Promise<string[]> {
  const [snapshot] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return (snapshot.chat as ChatState).messages.map((message) =>
    typeof message.content === "string"
      ? `${message.role}: ${message.content}`
      : `${message.role}: ${(message.content as { text?: string }[]).map((block) => block.text).join("")}`,
  );
}

/** The agent's messages as seen live. */
const said = (server: TestServer, agentId: string) =>
  (server.events.eventsOf(`agent:${agentId}`) as AgentEvent[]).flatMap((event) => {
    const pi =
      event.type === "pi"
        ? (event.event as { type: string; message?: { role: string; content: unknown } })
        : undefined;
    if (pi?.type !== "message_end" || !pi.message) return [];
    const { role, content } = pi.message;
    return [
      `${role}: ${typeof content === "string" ? content : (content as { text?: string }[]).map((block) => block.text).join("")}`,
    ];
  });

/** A user pipeline file in the server's home. */
function userPipeline(home: string, id: string, text: string): string {
  mkdirSync(join(home, "pipelines"), { recursive: true });
  const path = join(home, "pipelines", `${id}.toml`);
  writeFileSync(path, text);
  return path;
}

const IMPLEMENT = `id = "p"

[[stage]]
name = "implement"
role = "worker"
tier = "route"
`;

const WITH_REVIEW = `${IMPLEMENT}
[[stage]]
name = "review"
role = "reviewer"
`;

const startRun = (server: TestServer, workspaceId: string, pipeline = "p") =>
  server.request("POST", `/api/pipelines/workspaces/${workspaceId}/runs`, {
    pipeline,
    brief: "Build the thing",
  });

const getRun = async (server: TestServer, id: string) =>
  (await json<{ run: PipelineRun }>(await server.request("GET", `/api/pipelines/runs/${id}`))).run;

/** Starts a run and waits until its worker stage agent has answered its first prompt. */
async function startAndWork(server: TestServer, workspaceId: string) {
  const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);
  await until(async () => (await getRun(server, run.id)).workerAgentId !== undefined);
  const { workerAgentId } = await getRun(server, run.id);
  await until(() => said(server, workerAgentId as string).some((m) => m.startsWith("assistant:")));
  return { runId: run.id, workerId: workerAgentId as string };
}

/** Stops the stage job, so a report is stored and the run stays where it is. */
function holdJobs(server: TestServer) {
  for (const job of server.services.jobs.list({ kind: "pipelines.stage" }))
    server.services.jobs.cancel(job.id);
}

const DONE = { summary: "Done", tests: [{ name: "adds", proof: "proofs/adds.md" }] };

describe("a pipeline run", () => {
  it("stores the file's hash and stages, and a later edit does not change the run", async () => {
    const server = await start({ env: scriptEnv({ worker: ["hang"] }) });
    const { workspaceId } = await workspace(server, "stored");
    const path = userPipeline(server.paths.root, "p", IMPLEMENT);

    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);
    userPipeline(server.paths.root, "p", `${IMPLEMENT}\n# edited\n`);

    expect(run).toMatchObject({
      pipelineId: "p",
      source: "user",
      path,
      hash: createHash("sha256").update(IMPLEMENT).digest("hex"),
      stages: [{ name: "implement", role: "worker", tier: "route" }],
      state: "running",
      brief: "Build the thing",
    });
    expect(await getRun(server, run.id)).toMatchObject({ hash: run.hash, stages: run.stages });
    const listed = await json<PipelineList>(
      await server.request("GET", `/api/pipelines/workspaces/${workspaceId}`),
    );
    expect(listed.pipelines.find((entry) => entry.id === "p")?.hash).not.toBe(run.hash);
  });

  it("runs the implement stage on a worker stage agent on spore/auto until it reports, then passes", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE] }) });
    const { workspaceId, agentId } = await workspace(server, "implement");
    userPipeline(server.paths.root, "p", IMPLEMENT);

    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);
    await until(async () => (await getRun(server, run.id)).state === "passed");

    const done = await getRun(server, run.id);
    const turn = done.turns[0] as PipelineTurn;
    expect(done).toMatchObject({
      askingAgentId: agentId,
      tests: [{ name: "adds", proof: "proofs/adds.md" }],
      turns: [{ stage: "implement", kind: "task", role: "worker", agentId: done.workerAgentId }],
    });
    expect(turn.report).toEqual({ ...DONE, turn: turn.id });
    const worker = await json<{ agent: { role: string; kind: string } }>(
      await server.request("GET", `/api/agents/${done.workerAgentId}`),
    );
    expect(worker.agent).toMatchObject({ role: "worker", kind: "stage" });
    const launched = readFileSync(join(scratch, "record.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> })
      .find((entry) => entry.env.PI_SPORE_AGENT_ID === done.workerAgentId);
    const { argv } = launched as { argv: string[] };
    expect(argv.slice(argv.indexOf("--provider"), argv.indexOf("--provider") + 4)).toEqual([
      "--provider",
      "spore",
      "--model",
      "auto",
    ]);
    const brief = await json<BridgeArtifactFile>(
      await asAgent(
        server,
        agentId,
        workspaceId,
      )("GET", `artifacts/file?scope=workspace&path=pipelines/${run.id}/brief.md`),
    );
    expect(brief.content).toBe("Build the thing");
    const prompt = (await chat(server, done.workerAgentId as string))[0];
    expect(prompt).toContain(`\nTurn: ${turn.id}\n`);
  });

  it("fails the run when the next stage is a reviewer stage, which is not built yet", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE] }) });
    const { workspaceId } = await workspace(server, "review");
    userPipeline(server.paths.root, "p", WITH_REVIEW);

    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);
    await until(async () => (await getRun(server, run.id)).state === "failed");

    expect(await getRun(server, run.id)).toMatchObject({
      stageIndex: 1,
      message: "stage review: reviewer stages are not built yet",
    });
  });

  it("answers 409 pipeline_running for a second start while a run is running", async () => {
    const server = await start({ env: scriptEnv({ worker: ["hang"] }) });
    const { workspaceId } = await workspace(server, "twice");
    userPipeline(server.paths.root, "p", IMPLEMENT);
    await json(await startRun(server, workspaceId), 201);

    const second = await startRun(server, workspaceId);

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "pipeline_running" } });
  });

  it("stops a run on cancel and then takes a new run", async () => {
    const server = await start({ env: scriptEnv({ worker: ["hang", "hang"] }) });
    const { workspaceId } = await workspace(server, "cancel");
    userPipeline(server.paths.root, "p", IMPLEMENT);
    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);

    const stopped = await json<{ run: PipelineRun }>(
      await server.request("POST", `/api/pipelines/runs/${run.id}/cancel`),
    );

    expect(stopped.run.state).toBe("stopped");
    await json(await startRun(server, workspaceId), 201);
  });
});

describe("report rules", () => {
  /** A run that waits on its worker, and the callers for it. */
  async function waiting(name: string) {
    const server = await start({ env: scriptEnv({ worker: ["hang"] }) });
    const { workspaceId, agentId } = await workspace(server, name);
    userPipeline(server.paths.root, "p", IMPLEMENT);
    const { runId, workerId } = await startAndWork(server, workspaceId);
    const turn = (await getRun(server, runId)).turns[0] as PipelineTurn;
    return {
      server,
      workspaceId,
      runId,
      turn,
      worker: asAgent(server, workerId, workspaceId),
      other: asAgent(server, agentId, workspaceId),
    };
  }

  it("refuses another agent's report with 403", async () => {
    const { other, turn } = await waiting("forbidden");

    const response = await other("POST", "reports", { turn: turn.id, summary: "Mine" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "not_your_turn" } });
  });

  it("answers 404 for an unknown turn", async () => {
    const { worker } = await waiting("unknown");

    const response = await worker("POST", "reports", { turn: "nope", summary: "x" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "turn_not_found" } });
  });

  it("refuses a worker report with a verdict with 400", async () => {
    const { worker, turn } = await waiting("verdict");

    const response = await worker("POST", "reports", {
      turn: turn.id,
      summary: "Fine",
      verdict: "approve",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_report" } });
  });

  it("returns the stored turn for a repeat", async () => {
    const { server, worker, turn } = await waiting("repeat");
    holdJobs(server);

    const first = await json<{ turn: PipelineTurn }>(
      await worker("POST", "reports", { turn: turn.id, summary: "First" }),
    );
    const again = await json<{ turn: PipelineTurn }>(
      await worker("POST", "reports", { turn: turn.id, summary: "Second" }),
    );

    expect(first.turn.report?.summary).toBe("First");
    expect(again.turn).toEqual(first.turn);
  });

  it("answers 409 turn_closed for a report on an older turn", async () => {
    const { server, worker, runId, turn } = await waiting("closed");
    holdJobs(server);
    server.store.run(
      `INSERT INTO pipelines_turns (id, run_id, stage_index, stage, round, kind, role, agent_id, created_at)
       VALUES ('later', ?, 0, 'implement', 1, 'fix', 'worker', ?, ?)`,
      runId,
      turn.agentId,
      server.services.now(),
    );

    const response = await worker("POST", "reports", { turn: turn.id, summary: "Late" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "turn_closed" } });
  });

  it("answers 409 run_ended for a report after the run was stopped", async () => {
    const { server, worker, runId, turn } = await waiting("ended");
    await json(await server.request("POST", `/api/pipelines/runs/${runId}/cancel`));

    const response = await worker("POST", "reports", { turn: turn.id, summary: "Too late" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "run_ended" } });
  });

  it("keeps every test in the manifest when a later report lists others", async () => {
    const { server, worker, runId, turn } = await waiting("manifest");
    holdJobs(server);
    await json(
      await worker("POST", "reports", {
        turn: turn.id,
        summary: "One",
        tests: [
          { name: "a", proof: "proofs/a1.md" },
          { name: "b", proof: "proofs/b.md" },
        ],
      }),
    );
    server.store.run(
      `INSERT INTO pipelines_turns (id, run_id, stage_index, stage, round, kind, role, agent_id, created_at)
       VALUES ('fix-turn', ?, 0, 'implement', 1, 'fix', 'worker', ?, ?)`,
      runId,
      turn.agentId,
      server.services.now(),
    );

    await json(
      await worker("POST", "reports", {
        turn: "fix-turn",
        summary: "Two",
        tests: [{ name: "a", proof: "proofs/a2.md" }],
      }),
    );

    expect((await getRun(server, runId)).tests).toEqual([
      { name: "a", proof: "proofs/a2.md" },
      { name: "b", proof: "proofs/b.md" },
    ]);
  });
});

describe("a restart in the middle of a stage (R6.6)", () => {
  it("tells the worker once, and the run passes when it reports", async () => {
    const home = join(scratch, "home");
    const env = scriptEnv({ worker: ["hang", { summary: "Done after restart" }] });
    const first = await start({ home, env });
    const { workspaceId } = await workspace(first, "restart");
    userPipeline(home, "p", IMPLEMENT);
    const { runId, workerId } = await startAndWork(first, workspaceId);
    const turn = (await getRun(first, runId)).turns[0] as PipelineTurn;
    const entry = servers.pop();
    await entry?.agents.manager().stopAll();
    entry?.server.close();

    const second = await start({ home, env, firstId: 1_000 });
    await until(async () => (await getRun(second, runId)).state === "passed");

    const restarted = `user: pi-spore restarted while you worked. Continue, then call report with this turn.\n\nTurn: ${turn.id}`;
    expect((await chat(second, workerId)).filter((message) => message === restarted)).toHaveLength(
      1,
    );
    expect((await getRun(second, runId)).turns[0]?.report?.summary).toBe("Done after restart");
  });
});
