import { join } from "node:path";
import { AgentsKey } from "@pi-spore/mod-agents/server";
import { ArtifactsKey } from "@pi-spore/mod-artifacts/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import {
  ApiError,
  type BridgeCaller,
  type JobStep,
  type ServerModule,
  type StepOutcome,
} from "@pi-spore/module-api";
import {
  type PipelineEvent,
  type PipelineRun,
  type PipelineRunState,
  type PipelineSource,
  type PipelineStage,
  type PipelineTurn,
  type PipelineTurnKind,
  parseJsonBody,
  type StageReport,
  StartPipelineRequest,
  type TestProof,
} from "@pi-spore/shared";
import { type Pipelines, PipelinesKey } from "./contract.js";
import { loadPipelines, ROUTE_MODEL } from "./files.js";

export * from "./contract.js";

/** Topic of a workspace's runs: `pipelines:<workspace id>`. */
export const PIPELINES_TOPIC = "pipelines:";

const MIGRATIONS = [
  `CREATE TABLE pipelines_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    source TEXT NOT NULL,
    path TEXT,
    hash TEXT NOT NULL,
    stages TEXT NOT NULL,
    brief TEXT NOT NULL,
    asking_agent_id TEXT NOT NULL,
    worker_agent_id TEXT,
    state TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    message TEXT,
    tests TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  // The database enforces one run per workspace at a time, behind the checks that answer 409.
  `CREATE UNIQUE INDEX pipelines_runs_one_active ON pipelines_runs (workspace_id)
    WHERE state IN ('running', 'waiting_user')`,
  `CREATE TABLE pipelines_turns (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    stage TEXT NOT NULL,
    round INTEGER NOT NULL,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    report TEXT,
    created_at INTEGER NOT NULL,
    reported_at INTEGER
  )`,
  "CREATE INDEX pipelines_turns_by_run ON pipelines_turns (run_id, created_at)",
];

// JSON columns are written by this module only: the database is inside the boundary.
interface RunRow {
  id: string;
  workspace_id: string;
  pipeline_id: string;
  source: PipelineSource;
  path: string | null;
  hash: string;
  stages: string;
  brief: string;
  asking_agent_id: string;
  worker_agent_id: string | null;
  state: PipelineRunState;
  stage_index: number;
  message: string | null;
  tests: string;
  created_at: number;
  ended_at: number | null;
}

interface TurnRow {
  id: string;
  run_id: string;
  stage_index: number;
  stage: string;
  round: number;
  kind: PipelineTurnKind;
  role: PipelineTurn["role"];
  agent_id: string;
  report: string | null;
  created_at: number;
  reported_at: number | null;
}

/** The job kind of a stage: key is the workspace id, so a workspace's stages run in order (ADR 0004). */
const STAGE_JOB = "pipelines.stage";
const NOT_ENDED = ["running", "waiting", "interrupted"] as const;
const ACTIVE_RUN = "state IN ('running', 'waiting_user')";

interface StageSubject {
  runId: string;
  stageIndex: number;
}

/** The server start that last waited for the stage's report. A different one means a restart (R6.6). */
interface StageCheckpoint {
  boot: string;
}

const turnToView = (row: TurnRow): PipelineTurn => ({
  id: row.id,
  runId: row.run_id,
  stageIndex: row.stage_index,
  stage: row.stage,
  round: row.round,
  kind: row.kind,
  role: row.role,
  agentId: row.agent_id,
  ...(row.report ? { report: JSON.parse(row.report) as StageReport } : {}),
  createdAt: row.created_at,
  ...(row.reported_at === null ? {} : { reportedAt: row.reported_at }),
});

const runToView = (row: RunRow, turns: readonly TurnRow[]): PipelineRun => ({
  id: row.id,
  workspaceId: row.workspace_id,
  pipelineId: row.pipeline_id,
  source: row.source,
  ...(row.path === null ? {} : { path: row.path }),
  hash: row.hash,
  stages: JSON.parse(row.stages) as PipelineStage[],
  brief: row.brief,
  askingAgentId: row.asking_agent_id,
  ...(row.worker_agent_id === null ? {} : { workerAgentId: row.worker_agent_id }),
  state: row.state,
  stageIndex: row.stage_index,
  ...(row.message === null ? {} : { message: row.message }),
  tests: JSON.parse(row.tests) as TestProof[],
  turns: turns.map(turnToView),
  createdAt: row.created_at,
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
});

/** Adds the new tests to the manifest, by name. A repeated name takes the new proof; no test is removed. */
function mergeTests(manifest: readonly TestProof[], reported: readonly TestProof[]): TestProof[] {
  const byName = new Map(manifest.map((test) => [test.name, test]));
  for (const test of reported) byName.set(test.name, test);
  return [...byName.values()];
}

const taskPrompt = (stage: PipelineStage, pipeline: string, turnId: string, briefPath: string) =>
  [
    `You are the "${stage.name}" stage of pipeline "${pipeline}". Implement the brief.`,
    "",
    `Turn: ${turnId}`,
    "",
    `The brief is the workspace artifact ${briefPath}. Read it first.`,
    "Write each new test first and keep the output of its failing run as a workspace artifact: that is its proof.",
    `When you are done, call report with turn ${turnId}, a short summary, and tests: one entry for each test you added, with its name and the artifact path of its proof.`,
    "Your turn ends only with that report.",
  ].join("\n");

const restartMessage = (turnId: string) =>
  `pi-spore restarted while you worked. Continue, then call report with this turn.\n\nTurn: ${turnId}`;

export const pipelinesModule: ServerModule = {
  id: "pipelines",
  requires: ["projects", "workspaces", "agents", "artifacts"],
  core: false,
  setup(host) {
    host.store.migrate("pipelines", MIGRATIONS);
    const projects = host.use(ProjectsKey);
    const workspaces = host.use(WorkspacesKey);
    const agents = host.use(AgentsKey);
    const artifacts = host.use(ArtifactsKey);
    const userDir = join(host.home.root, "pipelines");
    const bootId = host.newId();

    const loadRun = (id: string) =>
      host.store.get<RunRow>("SELECT * FROM pipelines_runs WHERE id = ?", id);
    const requireRun = (id: string): RunRow => {
      const run = loadRun(id);
      if (!run) throw new ApiError(404, "run_not_found", `No pipeline run ${id}`);
      return run;
    };
    const turnRows = (runId: string) =>
      host.store.all<TurnRow>(
        "SELECT * FROM pipelines_turns WHERE run_id = ? ORDER BY created_at, id",
        runId,
      );
    const latestTurn = (runId: string) =>
      host.store.get<TurnRow>(
        "SELECT * FROM pipelines_turns WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        runId,
      );
    const viewOf = (row: RunRow) => runToView(row, turnRows(row.id));
    const runsOf = (workspaceId: string): PipelineRun[] =>
      host.store
        .all<RunRow>(
          "SELECT * FROM pipelines_runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC",
          workspaceId,
        )
        .map(viewOf);

    const publish = (workspaceId: string) => {
      const event: PipelineEvent = { type: "runs", runs: runsOf(workspaceId) };
      host.events.publish(`${PIPELINES_TOPIC}${workspaceId}`, event);
    };
    host.events.onSubscribe(PIPELINES_TOPIC, (topic) => {
      const workspace = workspaces.get(topic.slice(PIPELINES_TOPIC.length));
      const event: PipelineEvent = { type: "runs", runs: runsOf(workspace.id) };
      return [event];
    });
    // The job moves a run on; the browser sees it here.
    host.jobs.onChange((job) => {
      if (job.kind === STAGE_JOB && job.key !== null) publish(job.key);
    });

    const requireNoActiveRun = (workspaceId: string) => {
      if (
        host.store.get(
          `SELECT 1 FROM pipelines_runs WHERE workspace_id = ? AND ${ACTIVE_RUN}`,
          workspaceId,
        )
      ) {
        throw new ApiError(
          409,
          "pipeline_running",
          "This workspace has a pipeline run that has not ended",
        );
      }
    };

    const endRun = (runId: string, state: "passed" | "failed" | "stopped", message?: string) => {
      host.store.run(
        "UPDATE pipelines_runs SET state = ?, message = ?, ended_at = ? WHERE id = ?",
        state,
        message ?? null,
        host.now(),
        runId,
      );
    };

    /** The run this step belongs to, or undefined when the run was stopped or has moved on: the job just ends. */
    const runOf = (subject: StageSubject): RunRow | undefined => {
      const run = loadRun(subject.runId);
      return run?.state === "running" && run.stage_index === subject.stageIndex ? run : undefined;
    };

    const advance = async ({
      subject,
    }: {
      subject: StageSubject;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      const run = runOf(subject);
      if (!run) return { next: null };
      const stage = (JSON.parse(run.stages) as PipelineStage[])[
        subject.stageIndex
      ] as PipelineStage;
      if (stage.role !== "worker") {
        // Slices 5 and 6 build the reviewer and gate stages.
        const kind = stage.role ?? "gate";
        return {
          next: null,
          commit: () =>
            endRun(run.id, "failed", `stage ${stage.name}: ${kind} stages are not built yet`),
        };
      }
      const briefPath = `pipelines/${run.id}/brief.md`;
      await artifacts.write({ scope: "workspace", id: run.workspace_id }, briefPath, run.brief);
      const model = stage.model ?? (stage.tier === "route" ? ROUTE_MODEL : undefined);
      return {
        checkpoint: { boot: bootId },
        commit: () => {
          const agent = agents.createStage(run.workspace_id, {
            role: "worker",
            title: stage.name,
            ...(model ? { model } : {}),
          });
          const turnId = host.newId();
          host.store.run(
            `INSERT INTO pipelines_turns (id, run_id, stage_index, stage, round, kind, role, agent_id, created_at)
             VALUES (?, ?, ?, ?, 1, 'task', 'worker', ?, ?)`,
            turnId,
            run.id,
            subject.stageIndex,
            stage.name,
            agent.id,
            host.now(),
          );
          host.store.run(
            "UPDATE pipelines_runs SET worker_agent_id = ? WHERE id = ?",
            agent.id,
            run.id,
          );
          agents.deliver(agent.id, taskPrompt(stage, run.pipeline_id, turnId, briefPath));
        },
      };
    };

    const awaitReport = async ({
      subject,
      checkpoint,
    }: {
      subject: StageSubject;
      checkpoint: StageCheckpoint | undefined;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      const run = runOf(subject);
      if (!run) return { next: null };
      const turn = latestTurn(run.id) as TurnRow;
      if (turn.report !== null) return {};
      if (checkpoint?.boot === bootId) return { wait: true };
      // The server restarted while the agent worked. Its process is gone, so it gets one reminder (R6.6).
      return {
        wait: true,
        checkpoint: { boot: bootId },
        commit: () => agents.deliver(turn.agent_id, restartMessage(turn.id)),
      };
    };

    /** The last step of every stage: starts the next stage's job, or ends the run. */
    const finish = async ({ subject }: { subject: StageSubject }): Promise<StepOutcome<never>> => {
      const run = runOf(subject);
      if (!run) return { next: null };
      return {
        next: null,
        commit: () => {
          if (subject.stageIndex + 1 >= (JSON.parse(run.stages) as PipelineStage[]).length) {
            endRun(run.id, "passed");
            return;
          }
          host.store.run(
            "UPDATE pipelines_runs SET stage_index = ? WHERE id = ?",
            subject.stageIndex + 1,
            run.id,
          );
          host.jobs.start(
            STAGE_JOB,
            { runId: run.id, stageIndex: subject.stageIndex + 1 },
            { key: run.workspace_id },
          );
        },
      };
    };

    const steps: JobStep<StageSubject, StageCheckpoint>[] = [
      { name: "advance", run: advance },
      { name: "await", run: awaitReport },
      { name: "finish", run: finish },
    ];
    host.jobs.define(STAGE_JOB, steps);

    const report = (caller: BridgeCaller, request: StageReport): { turn: PipelineTurn } => {
      const turn = host.store.transaction((): TurnRow => {
        const row = host.store.get<TurnRow>(
          "SELECT * FROM pipelines_turns WHERE id = ?",
          request.turn,
        );
        if (!row) throw new ApiError(404, "turn_not_found", `No turn ${request.turn}`);
        if (row.agent_id !== caller.agentId)
          throw new ApiError(403, "not_your_turn", `Turn ${row.id} belongs to another agent`);
        if ((latestTurn(row.run_id) as TurnRow).id !== row.id)
          throw new ApiError(409, "turn_closed", `Turn ${row.id} is closed; a later turn is open`);
        if (row.report !== null) return row;
        const run = requireRun(row.run_id);
        if (run.state !== "running")
          throw new ApiError(409, "run_ended", `The run is ${run.state}; it takes no more reports`);
        if (row.role === "worker" && request.verdict !== undefined)
          throw new ApiError(400, "bad_report", "A worker report has no verdict");
        if (row.role === "worker" && request.earlyStop !== undefined)
          throw new ApiError(400, "bad_report", "A worker report has no earlyStop");
        const reportedAt = host.now();
        host.store.run(
          "UPDATE pipelines_turns SET report = ?, reported_at = ? WHERE id = ?",
          JSON.stringify(request),
          reportedAt,
          row.id,
        );
        if (request.tests) {
          host.store.run(
            "UPDATE pipelines_runs SET tests = ? WHERE id = ?",
            JSON.stringify(mergeTests(JSON.parse(run.tests) as TestProof[], request.tests)),
            run.id,
          );
        }
        host.jobs.wake(STAGE_JOB, run.workspace_id);
        return { ...row, report: JSON.stringify(request), reported_at: reportedAt };
      });
      publish(requireRun(turn.run_id).workspace_id);
      return { turn: turnToView(turn) };
    };
    const api: Pipelines = { report };
    host.provide(PipelinesKey, api);

    const entriesOf = async (workspaceId: string) => {
      const workspace = workspaces.get(workspaceId);
      const project = await projects.get(workspace.projectId);
      return loadPipelines(userDir, join(project.path, ".pi-spore", "pipelines"));
    };

    host.routes.get("/workspaces/:id", async (c) =>
      c.json({ pipelines: await entriesOf(c.req.param("id")) }),
    );

    host.routes.get("/workspaces/:id/runs", (c) =>
      c.json({ runs: runsOf(workspaces.get(c.req.param("id")).id) }),
    );

    host.routes.post("/workspaces/:id/runs", async (c) => {
      const request = parseJsonBody(StartPipelineRequest, await c.req.text(), "pipeline request");
      const workspace = workspaces.get(c.req.param("id"));
      if (workspace.state !== "active") {
        throw new ApiError(
          409,
          "workspace_not_active",
          `The workspace is ${workspace.state}; pipelines run only in active workspaces`,
        );
      }
      requireNoActiveRun(workspace.id);
      const entry = (await entriesOf(workspace.id)).find((found) => found.id === request.pipeline);
      if (!entry)
        throw new ApiError(404, "pipeline_not_found", `No pipeline "${request.pipeline}"`);
      if ("error" in entry) throw new ApiError(422, "bad_pipeline", entry.error);
      const asking = await agents.activeWorker(workspace.id);
      const runId = host.store.transaction(() => {
        requireNoActiveRun(workspace.id);
        const id = host.newId();
        host.store.run(
          `INSERT INTO pipelines_runs (id, workspace_id, pipeline_id, source, path, hash, stages, brief,
             asking_agent_id, state, stage_index, tests, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, '[]', ?)`,
          id,
          workspace.id,
          entry.id,
          entry.source,
          entry.path ?? null,
          entry.hash,
          JSON.stringify(entry.stages),
          request.brief,
          asking.id,
          host.now(),
        );
        host.jobs.start(STAGE_JOB, { runId: id, stageIndex: 0 }, { key: workspace.id });
        return id;
      });
      publish(workspace.id);
      return c.json({ run: viewOf(requireRun(runId)) }, 201);
    });

    host.routes.get("/runs/:id", (c) => c.json({ run: viewOf(requireRun(c.req.param("id"))) }));

    host.routes.post("/runs/:id/cancel", (c) => {
      const run = requireRun(c.req.param("id"));
      host.store.transaction(() => {
        if (run.state !== "running" && run.state !== "waiting_user")
          throw new ApiError(409, "run_ended", `The run is ${run.state}`);
        endRun(run.id, "stopped", "Stopped by the user");
        for (const job of host.jobs.list({
          kind: STAGE_JOB,
          key: run.workspace_id,
          states: NOT_ENDED,
        })) {
          if ((job.subject as StageSubject).runId === run.id) host.jobs.cancel(job.id);
        }
      });
      publish(run.workspace_id);
      return c.json({ run: viewOf(requireRun(run.id)) });
    });
  },
};
