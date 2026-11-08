import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";
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
import type { JobView } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type {
  ActionRun,
  Approval,
  BridgeArtifactFile,
  ChatState,
  PipelineList,
  PipelineRun,
  PipelineTurn,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));
const GATE_ACTION = fileURLToPath(new URL("../test-fixtures/gate-action.mjs", import.meta.url));

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
async function workspace(
  server: TestServer,
  name: string,
  options: { git?: boolean; config?: string } = {},
) {
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(join(folder, ".pi-spore", "config.toml"), options.config ?? "");
  if (options.git) {
    writeFileSync(join(folder, "a.txt"), "one\n");
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "."],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"],
      ["checkout", "-q", "-b", "feature"],
    ]) {
      execFileSync("git", args, { cwd: folder });
    }
  }
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
  return { workspaceId: workspace.id, agentId: agent.id, folder };
}

/** What a worker leaves in a git workspace: a commit, an edited tracked file, and an untracked file. */
function workerChange(folder: string) {
  writeFileSync(join(folder, "committed.txt"), "committed line\n");
  execFileSync("git", ["add", "committed.txt"], { cwd: folder });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"], {
    cwd: folder,
  });
  writeFileSync(join(folder, "a.txt"), "one\nedited line\n");
  writeFileSync(join(folder, "new.txt"), "untracked line\n");
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

/** A review stage after the implement stage; `lines` are more keys of the stage. */
const withReview = (...lines: string[]) =>
  `${IMPLEMENT}\n[[stage]]\nname = "review"\nrole = "reviewer"\n${lines.join("\n")}\n`;

const withAdversarial = (...lines: string[]) =>
  `${IMPLEMENT}\n[[stage]]\nname = "adversarial"\nrole = "adversarial-reviewer"\n${lines.join("\n")}\n`;

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

const FIX = { summary: "Fixed the findings" };
const FINDING = { severity: "important", title: "Missing null check", file: "a.txt", line: 2 };
const TIERS = {
  "spore/auto": "local",
  "fake/strong": "heavy",
  "fake/weak": "local",
  "fake/mid": "medium",
};

const writeTiers = (home: string, tiers: Record<string, string>) =>
  writeFileSync(join(home, "settings.json"), JSON.stringify({ tiers }));

/** A stage agent as the server shows it, and how its process was launched. */
async function stageAgent(server: TestServer, agentId: string) {
  const { agent } = await json<{ agent: { role: string; title: string; kind: string } }>(
    await server.request("GET", `/api/agents/${agentId}`),
  );
  const launched = readFileSync(join(scratch, "record.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> })
    .find((entry) => entry.env.PI_SPORE_AGENT_ID === agentId);
  const { argv } = launched as { argv: string[] };
  return { agent, tools: argv[argv.indexOf("--tools") + 1] };
}

/** Starts a run on a fresh workspace and waits for the run to end in `state`. */
async function runUntil(
  server: TestServer,
  name: string,
  pipeline: string,
  state: PipelineRun["state"],
) {
  const { workspaceId } = await workspace(server, name);
  userPipeline(server.paths.root, "p", pipeline);
  const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);
  await until(async () => (await getRun(server, run.id)).state === state);
  return { workspaceId, run: await getRun(server, run.id) };
}

const kinds = (run: PipelineRun) => run.turns.map((turn) => `${turn.kind}${turn.round}`);

describe("a review stage", () => {
  it("sends a REVISE to the same worker, then a fresh reviewer runs round 2, and APPROVE passes", async () => {
    const server = await start({
      env: scriptEnv({
        worker: [DONE, FIX],
        reviewer: [
          { summary: "Not yet", verdict: "revise", findings: [FINDING] },
          { summary: "Good", verdict: "approve" },
        ],
      }),
    });

    const { run } = await runUntil(server, "revise", withReview("rounds = 2"), "passed");

    expect(kinds(run)).toEqual(["task1", "review1", "fix1", "review2"]);
    const [task, first, fix, second] = run.turns as [
      PipelineTurn,
      PipelineTurn,
      PipelineTurn,
      PipelineTurn,
    ];
    expect(fix.agentId).toBe(task.agentId);
    expect(second.agentId).not.toBe(first.agentId);
    const prompt = (await chat(server, task.agentId)).find((message) =>
      message.includes(`Turn: ${fix.id}`),
    );
    expect(prompt).toContain("[important] Missing null check (a.txt:2)");
    expect(prompt).toContain("Reviewer summary: Not yet");
    const [one, two] = await Promise.all([
      stageAgent(server, first.agentId),
      stageAgent(server, second.agentId),
    ]);
    expect(one.agent).toMatchObject({ role: "reviewer", kind: "stage", title: "Review 1" });
    expect(two.agent).toMatchObject({ role: "reviewer", kind: "stage", title: "Review 2" });
    expect(one.tools).not.toMatch(/bash|edit|write/);
  });

  it("asks the reviewer to check each proof, and names the brief, the diff, and the tests", async () => {
    const server = await start({
      env: scriptEnv({ worker: [DONE], reviewer: [{ summary: "Good", verdict: "approve" }] }),
    });
    const { workspaceId, agentId, folder } = await workspace(server, "prompt", { git: true });
    workerChange(folder);
    userPipeline(server.paths.root, "p", withReview());
    const { run: started } = await json<{ run: PipelineRun }>(
      await startRun(server, workspaceId),
      201,
    );
    await until(async () => (await getRun(server, started.id)).state === "passed");

    const run = await getRun(server, started.id);
    const reviewer = run.turns[1] as PipelineTurn;
    const prompt = (await chat(server, reviewer.agentId))[0];
    expect(prompt).toContain(`\nTurn: ${reviewer.id}\n`);
    expect(prompt).toContain(`pipelines/${run.id}/brief.md`);
    expect(prompt).toContain(`pipelines/${run.id}/review-1.diff`);
    expect(prompt).toContain("- adds: proof proofs/adds.md");
    expect(prompt).toContain("every test the change adds is in this list");
    const diff = await json<BridgeArtifactFile>(
      await asAgent(
        server,
        agentId,
        workspaceId,
      )("GET", `artifacts/file?scope=workspace&path=pipelines/${run.id}/review-1.diff`),
    );
    expect(diff.content).toContain("## Committed since main");
    expect(diff.content).toContain("+committed line");
    expect(diff.content).toContain("## Uncommitted and untracked");
    expect(diff.content).toContain("+edited line");
    expect(diff.content).toContain("+untracked line");
  });

  it("says there is no diff for a project without change support", async () => {
    const server = await start({
      env: scriptEnv({ worker: [DONE], reviewer: [{ summary: "Good", verdict: "approve" }] }),
    });
    const { workspaceId, agentId } = await workspace(server, "nodiff");
    userPipeline(server.paths.root, "p", withReview());
    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);
    await until(async () => (await getRun(server, run.id)).state === "passed");

    const diff = await json<BridgeArtifactFile>(
      await asAgent(
        server,
        agentId,
        workspaceId,
      )("GET", `artifacts/file?scope=workspace&path=pipelines/${run.id}/review-1.diff`),
    );

    expect(diff.content).toContain("No diff");
    expect(diff.content).toContain("Read the files");
  });
});

describe("the round limit", () => {
  const REVISE = { summary: "Still wrong", verdict: "revise", findings: [FINDING] };
  const limited = () => scriptEnv({ worker: [DONE, FIX], reviewer: [REVISE, REVISE] });

  const openApprovals = async (server: TestServer) =>
    (
      await json<{ approvals: Approval[] }>(
        await server.request("GET", "/api/attention/approvals?state=open"),
      )
    ).approvals;

  it("waits on a pipeline-round-limit approval after two REVISEs, and approve passes the run", async () => {
    const server = await start({ env: limited() });
    const { run } = await runUntil(server, "limit", withReview("rounds = 2"), "waiting_user");

    expect(kinds(run)).toEqual(["task1", "review1", "fix1", "review2"]);
    const [approval] = await openApprovals(server);
    expect(approval).toMatchObject({
      kind: "pipeline-round-limit",
      subject: { runId: run.id, stage: "review" },
      agentId: run.askingAgentId,
    });
    await json(
      await server.request("POST", `/api/attention/approvals/${approval?.id}/approve`, {}),
    );
    await until(async () => (await getRun(server, run.id)).state === "passed");
    expect(kinds(await getRun(server, run.id))).toEqual(["task1", "review1", "fix1", "review2"]);
  });

  it("stops the run when the user declines", async () => {
    const server = await start({ env: limited() });
    const { run } = await runUntil(server, "decline", withReview("rounds = 2"), "waiting_user");
    const [approval] = await openApprovals(server);

    await json(
      await server.request("POST", `/api/attention/approvals/${approval?.id}/decline`, {}),
    );

    expect(await getRun(server, run.id)).toMatchObject({
      state: "stopped",
      message: "Declined at the review round limit",
    });
  });

  it("keeps waiting after a restart, and a job retry does not move it on", async () => {
    const home = join(scratch, "home");
    const env = limited();
    const first = await start({ home, env });
    const { run } = await runUntil(first, "restartlimit", withReview("rounds = 2"), "waiting_user");
    const entry = servers.pop();
    await entry?.agents.manager().stopAll();
    entry?.server.close();

    const second = await start({ home, env, firstId: 1_000 });
    const stageJob = () =>
      second.services.jobs.list({
        kind: "pipelines.stage",
        states: ["running", "waiting"],
      })[0] as JobView;
    await until(() => stageJob().state === "waiting");
    expect(stageJob().step).toBe("decide");
    const retried = await json<JobView>(
      await second.request("POST", `/api/jobs/${stageJob().id}/retry`),
    );
    await until(() => stageJob().state === "waiting");

    expect(retried.state).toBe("running");
    expect(await getRun(second, run.id)).toMatchObject({ state: "waiting_user" });
    expect(kinds(await getRun(second, run.id))).toEqual(["task1", "review1", "fix1", "review2"]);
    expect(await openApprovals(second)).toHaveLength(1);
  });
});

describe("min_strength_over (R4.4)", () => {
  const STRONG = withReview('model = "fake/weak"', 'min_strength_over = "implement"');

  it("starts no reviewer on a model that is not stronger, and a settings fix plus a retry starts it", async () => {
    const server = await start({
      env: scriptEnv({ worker: [DONE], reviewer: [{ summary: "Good", verdict: "approve" }] }),
    });
    writeTiers(server.paths.root, TIERS);
    const { workspaceId } = await workspace(server, "weak");
    userPipeline(server.paths.root, "p", STRONG);
    const { run: started } = await json<{ run: PipelineRun }>(
      await startRun(server, workspaceId),
      201,
    );

    await until(async () => (await getRun(server, started.id)).blocked !== undefined);

    const blocked = await getRun(server, started.id);
    expect(blocked.state).toBe("running");
    expect(blocked.blocked).toContain("fake/weak (tier local)");
    expect(blocked.blocked).toContain("spore/auto (tier local)");
    expect(blocked.turns).toHaveLength(1);
    const records = readFileSync(join(scratch, "record.jsonl"), "utf8");
    expect(records).not.toContain('"PI_SPORE_STAGE_ROLE":"reviewer"');
    writeTiers(server.paths.root, { ...TIERS, "fake/weak": "heavy" });
    const job = server.services.jobs.list({
      kind: "pipelines.stage",
      states: ["waiting"],
    })[0] as JobView;
    await json(await server.request("POST", `/api/jobs/${job.id}/retry`));
    await until(async () => (await getRun(server, started.id)).state === "passed");
    expect((await getRun(server, started.id)).blocked).toBeUndefined();
  });

  it("names the missing tier setting when the reviewer model has no tier", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE], reviewer: [] }) });
    writeTiers(server.paths.root, { "spore/auto": "local" });
    const { workspaceId } = await workspace(server, "notier");
    userPipeline(
      server.paths.root,
      "p",
      withReview('model = "fake/unlisted"', 'min_strength_over = "implement"'),
    );
    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);

    await until(async () => (await getRun(server, run.id)).blocked !== undefined);

    expect((await getRun(server, run.id)).blocked).toContain("fake/unlisted has no tier");
  });

  it("fails the run when the reviewer ran on a weaker model than it started on", async () => {
    const server = await start({
      env: scriptEnv({
        worker: [DONE],
        reviewer: [{ summary: "Good", verdict: "approve", model: "fake/weak" }],
      }),
    });
    writeTiers(server.paths.root, { ...TIERS, "spore/auto": "light" });
    const { run } = await runUntil(
      server,
      "weaker",
      withReview('model = "fake/strong"', 'min_strength_over = "implement"'),
      "failed",
    );

    expect(run.message).toContain("R4.4");
    expect(run.message).toContain(
      "fake/weak (tier local) is not stronger than spore/auto (tier light)",
    );
  });
});

describe("the Jev early stop (ADR 0015)", () => {
  const MINOR = { severity: "minor", title: "Naming" };
  const STOP = { stop: true, probability: 0.9 };
  const reviewer = (...entries: unknown[]) => scriptEnv({ worker: [DONE, FIX], reviewer: entries });

  it("ends the stage after one fix when Jev stops a REVISE with minor findings", async () => {
    const server = await start({
      env: reviewer({ summary: "Nits", verdict: "revise", findings: [MINOR], earlyStop: STOP }),
    });

    const { run } = await runUntil(
      server,
      "jev",
      withReview("rounds = 2", 'early_stop = "jev"'),
      "passed",
    );

    expect(kinds(run)).toEqual(["task1", "review1", "fix1"]);
    expect(run.turns[1]?.report?.earlyStop).toEqual(STOP);
    const prompt = (await chat(server, run.workerAgentId as string)).find((message) =>
      message.includes(`Turn: ${run.turns[2]?.id}`),
    );
    expect(prompt).toContain("This is the last fix");
  });

  it("runs round 2 when a finding is blocking (Jev cannot veto it)", async () => {
    const server = await start({
      env: reviewer(
        {
          summary: "Bad",
          verdict: "revise",
          findings: [{ ...MINOR, severity: "blocking" }],
          earlyStop: STOP,
        },
        { summary: "Good", verdict: "approve" },
      ),
    });

    const { run } = await runUntil(
      server,
      "veto",
      withReview("rounds = 2", 'early_stop = "jev"'),
      "passed",
    );

    expect(kinds(run)).toEqual(["task1", "review1", "fix1", "review2"]);
  });

  it("ignores earlyStop when the stage has no early_stop", async () => {
    const server = await start({
      env: reviewer(
        { summary: "Nits", verdict: "revise", findings: [MINOR], earlyStop: STOP },
        { summary: "Good", verdict: "approve" },
      ),
    });

    const { run } = await runUntil(server, "ignored", withReview("rounds = 2"), "passed");

    expect(kinds(run)).toEqual(["task1", "review1", "fix1", "review2"]);
  });
});

describe("an adversarial stage", () => {
  it("ends after one worker fix on REVISE, with no second adversarial reviewer", async () => {
    const server = await start({
      env: scriptEnv({
        worker: [DONE, FIX],
        "adversarial-reviewer": [{ summary: "Broken", verdict: "revise", findings: [FINDING] }],
      }),
    });

    const { run } = await runUntil(
      server,
      "adversarial",
      withAdversarial("rounds = 1", "fix_passes = 1"),
      "passed",
    );

    expect(kinds(run)).toEqual(["task1", "review1", "fix1"]);
    const stage = await stageAgent(server, (run.turns[1] as PipelineTurn).agentId);
    expect(stage.agent).toMatchObject({ role: "adversarial-reviewer", title: "Adversarial 1" });
  });
});

describe("reviewer report rules", () => {
  it("refuses a report without a verdict and a report with tests, both with 400", async () => {
    const server = await start({
      env: scriptEnv({ worker: [DONE], reviewer: ["hang"] }),
    });
    const { workspaceId } = await workspace(server, "rules");
    userPipeline(server.paths.root, "p", withReview());
    const { run: started } = await json<{ run: PipelineRun }>(
      await startRun(server, workspaceId),
      201,
    );
    await until(async () => (await getRun(server, started.id)).turns.length === 2);
    const turn = (await getRun(server, started.id)).turns[1] as PipelineTurn;
    await until(() =>
      said(server, turn.agentId).some((message) => message.startsWith("assistant:")),
    );
    const reviewer = asAgent(server, turn.agentId, workspaceId);

    const noVerdict = await reviewer("POST", "reports", { turn: turn.id, summary: "Fine" });
    const withTests = await reviewer("POST", "reports", {
      turn: turn.id,
      summary: "Fine",
      verdict: "approve",
      tests: [{ name: "x", proof: "p.md" }],
    });

    expect(noVerdict.status).toBe(400);
    expect(await noVerdict.json()).toMatchObject({ error: { code: "bad_report" } });
    expect(withTests.status).toBe(400);
    expect(await withTests.json()).toMatchObject({ error: { code: "bad_report" } });
    expect((await getRun(server, started.id)).turns[1]?.report).toBeUndefined();
  });
});

describe("a gate stage", () => {
  const GATES = `${IMPLEMENT}\n[[stage]]\nname = "gates"\ngates = ["check", "test"]\nfail_first = "artifact"\n`;
  const reviewThenGates = `${withReview("rounds = 1", "fix_passes = 1")}\n[[stage]]\nname = "gates"\ngates = ["check"]\nfail_first = "artifact"\n`;

  /** The labels the gate actions appended to the counter file, one per run. */
  const counterOf = () => join(scratch, "counter.txt");
  const ran = (): string[] =>
    existsSync(counterOf()) ? readFileSync(counterOf(), "utf8").split("\n").filter(Boolean) : [];

  /** config.toml text that declares each action as the gate-action fixture in the given mode. */
  const config = (modes: Record<string, string>) =>
    Object.entries(modes)
      .map(
        ([name, mode]) =>
          `[actions.${name}]\nrun = ${JSON.stringify([process.execPath, GATE_ACTION, counterOf(), name, mode])}\n`,
      )
      .join("\n");

  /** A workspace artifact, as a worker would have saved it. */
  const saveArtifact = (server: TestServer, workspaceId: string, path: string, content: string) => {
    const file = join(server.paths.artifacts, "workspaces", workspaceId, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  const actionRuns = async (server: TestServer, workspaceId: string) =>
    (
      await json<{ runs: ActionRun[] }>(
        await server.request("GET", `/api/actions/workspaces/${workspaceId}/runs`),
      )
    ).runs;

  /** Starts `pipeline` in a fresh workspace whose actions run in `modes`, with the proof `adds` already saved. */
  async function startGates(
    server: TestServer,
    name: string,
    pipeline: string,
    modes: Record<string, string>,
  ) {
    const { workspaceId } = await workspace(server, name, { config: config(modes) });
    saveArtifact(server, workspaceId, "proofs/adds.md", "FAIL: adds\n");
    userPipeline(server.paths.root, "p", pipeline);
    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);
    return { workspaceId, runId: run.id };
  }

  const untilState = (server: TestServer, runId: string, state: PipelineRun["state"]) =>
    until(async () => (await getRun(server, runId)).state === state);

  it("fails the run for a missing proof, and starts no gate action", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE] }) });
    const { workspaceId } = await workspace(server, "noproof", {
      config: config({ check: "pass", test: "pass" }),
    });
    userPipeline(server.paths.root, "p", GATES);
    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);

    await untilState(server, run.id, "failed");

    expect((await getRun(server, run.id)).message).toBe(
      "missing fail-first proof for adds (proofs/adds.md)",
    );
    expect(ran()).toEqual([]);
    expect(await actionRuns(server, workspaceId)).toEqual([]);
  });

  it("fails the run for an empty proof", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE] }) });
    const { workspaceId } = await workspace(server, "emptyproof", {
      config: config({ check: "pass", test: "pass" }),
    });
    saveArtifact(server, workspaceId, "proofs/adds.md", "");
    userPipeline(server.paths.root, "p", GATES);
    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);

    await untilState(server, run.id, "failed");

    expect((await getRun(server, run.id)).message).toContain("missing fail-first proof for adds");
    expect(ran()).toEqual([]);
  });

  it("still needs the proof of a test that a later worker report leaves out", async () => {
    const server = await start({
      env: scriptEnv({
        worker: [
          {
            summary: "Done",
            tests: [
              { name: "a", proof: "proofs/a.md" },
              { name: "b", proof: "proofs/b.md" },
            ],
          },
          { summary: "Fixed", tests: [{ name: "a", proof: "proofs/a.md" }] },
        ],
        reviewer: [{ summary: "Not yet", verdict: "revise", findings: [FINDING] }],
      }),
    });
    const { workspaceId } = await workspace(server, "dropped", {
      config: config({ check: "pass" }),
    });
    saveArtifact(server, workspaceId, "proofs/a.md", "FAIL: a\n");
    userPipeline(server.paths.root, "p", reviewThenGates);
    const { run } = await json<{ run: PipelineRun }>(await startRun(server, workspaceId), 201);

    await untilState(server, run.id, "failed");

    const done = await getRun(server, run.id);
    expect(kinds(done)).toEqual(["task1", "review1", "fix1"]);
    expect(done.message).toBe("missing fail-first proof for b (proofs/b.md)");
    expect(ran()).toEqual([]);
  });

  it("passes the default shape: implement, review, adversarial, then each gate once with trigger pipeline", async () => {
    const server = await start({
      env: scriptEnv({
        worker: [DONE],
        reviewer: [{ summary: "Good", verdict: "approve" }],
        "adversarial-reviewer": [{ summary: "Solid", verdict: "approve" }],
      }),
    });
    writeTiers(server.paths.root, TIERS);
    const pipeline = `${IMPLEMENT}
[[stage]]
name = "review"
role = "reviewer"
model = "fake/strong"
rounds = 2
min_strength_over = "implement"

[[stage]]
name = "adversarial"
role = "adversarial-reviewer"
model = "fake/strong"
rounds = 1
fix_passes = 1

[[stage]]
name = "gates"
gates = ["check", "test"]
fail_first = "artifact"
`;

    const { workspaceId, runId } = await startGates(server, "default", pipeline, {
      check: "pass",
      test: "pass",
    });
    await untilState(server, runId, "passed");

    expect(kinds(await getRun(server, runId))).toEqual(["task1", "review1", "review1"]);
    expect(ran()).toEqual(["check", "test"]);
    const runs = await actionRuns(server, workspaceId);
    expect(runs.map((run) => [run.action, run.trigger, run.status]).sort()).toEqual([
      ["check", "pipeline", "succeeded"],
      ["test", "pipeline", "succeeded"],
    ]);
  });

  it("ends the run failed with the log tail of the failing gate, and runs no later gate", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE] }) });

    const { runId } = await startGates(server, "failing", GATES, { check: "fail", test: "pass" });
    await untilState(server, runId, "failed");

    const run = await getRun(server, runId);
    expect(run.message).toContain("gate check failed");
    expect(run.message).toContain("gate output: boom");
    expect(ran()).toEqual(["check"]);
  });

  it("starts one new attempt for a gate action that a restart cut off, and the run passes", async () => {
    const home = join(scratch, "home");
    const env = scriptEnv({ worker: [DONE] });
    const first = await start({ home, env });
    const { workspaceId } = await workspace(first, "restartgate", {
      config: config({ check: "pass", test: "hang-first" }),
    });
    saveArtifact(first, workspaceId, "proofs/adds.md", "FAIL: adds\n");
    userPipeline(home, "p", GATES);
    const { run } = await json<{ run: PipelineRun }>(await startRun(first, workspaceId), 201);
    await until(() => ran().length === 2);
    const entry = servers.pop();
    await entry?.agents.manager().stopAll();
    entry?.server.close();

    const second = await start({ home, env, firstId: 1_000 });
    await untilState(second, run.id, "passed");

    expect(ran()).toEqual(["check", "test", "test"]);
    const runs = await actionRuns(second, workspaceId);
    expect(runs.map((found) => [found.action, found.status]).sort()).toEqual([
      ["check", "succeeded"],
      ["test", "interrupted"],
      ["test", "succeeded"],
    ]);
  });

  it("starts no second action when a gate step runs again under the same key", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE] }) });
    const { workspaceId, runId } = await startGates(server, "samekey", GATES, {
      check: "pass",
      test: "pass",
    });
    await untilState(server, runId, "passed");
    // A crash after the actions ended but before the stage moved on leaves this state: the job is on the gate step
    // with no checkpoint. The test sets it by hand, since a real crash cannot be timed.
    server.store.run(
      "UPDATE pipelines_runs SET state = 'running', ended_at = NULL, message = NULL WHERE id = ?",
      runId,
    );
    const job = server.services.jobs
      .list({ kind: "pipelines.stage" })
      .find((found) => (found.subject as { stageIndex: number }).stageIndex === 1) as JobView;
    server.store.run(
      "UPDATE core_jobs SET state = 'waiting', step = 'gate', checkpoint = NULL WHERE id = ?",
      job.id,
    );

    await json(await server.request("POST", `/api/jobs/${job.id}/retry`));
    await untilState(server, runId, "passed");

    expect(ran()).toEqual(["check", "test"]);
    expect(await actionRuns(server, workspaceId)).toHaveLength(2);
  });

  it("waits with the error for an unknown action, and a retry after the fix runs it", async () => {
    const server = await start({ env: scriptEnv({ worker: [DONE] }) });
    const { workspaceId, runId } = await startGates(server, "unknown", GATES, { check: "pass" });
    await until(async () => (await getRun(server, runId)).blocked !== undefined);

    expect((await getRun(server, runId)).blocked).toContain("test");
    expect(ran()).toEqual(["check"]);
    const folder = join(scratch, "unknown");
    writeFileSync(
      join(folder, ".pi-spore", "config.toml"),
      config({ check: "pass", test: "pass" }),
    );
    const job = server.services.jobs.list({ kind: "pipelines.stage", states: ["waiting"] })[0];
    await json(await server.request("POST", `/api/jobs/${job?.id}/retry`));
    await untilState(server, runId, "passed");

    expect(ran()).toEqual(["check", "test"]);
    expect(await actionRuns(server, workspaceId)).toHaveLength(2);
  });
});
