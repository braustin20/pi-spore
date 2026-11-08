import { AgentsKey } from "@pi-spore/mod-agents/server";
import { ArtifactsKey } from "@pi-spore/mod-artifacts/server";
import { ApprovalsKey } from "@pi-spore/mod-attention/server";
import { PipelinesKey } from "@pi-spore/mod-pipelines/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import {
  ApiError,
  type BridgeCaller,
  type JobStep,
  type ServerModule,
  type StepOutcome,
} from "@pi-spore/module-api";
import { loadSettings, TIERS, tierOf } from "@pi-spore/router";
import {
  CreateRunRequest,
  type Lane,
  type LaneState,
  parseJsonBody,
  type ReviseLaneRequest,
  type Run,
  type StartLaneRequest,
  slugify,
} from "@pi-spore/shared";
import Type, { type Static } from "typebox";
import { type Runs, RunsKey } from "./contract.js";

export * from "./contract.js";

/** The coordinator's tools (ADR 0150): read tools, artifacts, questions, and the run tools. No write or shell tool. */
export const COORDINATOR_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "request_human_input",
  "artifacts_list",
  "artifacts_read",
  "artifacts_write",
  "start_lane",
  "revise_lane",
  "merge_lane",
  "answer_lane",
];

const MIGRATIONS = [
  `CREATE TABLE runs_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    line TEXT NOT NULL,
    base TEXT NOT NULL,
    gates TEXT NOT NULL,
    coordinator_agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE UNIQUE INDEX runs_runs_by_workspace ON runs_runs (workspace_id)",
  `CREATE TABLE runs_lanes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    name TEXT NOT NULL,
    wave INTEGER NOT NULL,
    depends_on TEXT NOT NULL,
    brief TEXT NOT NULL,
    pipeline TEXT NOT NULL,
    model TEXT,
    state TEXT NOT NULL,
    workspace_id TEXT,
    pipeline_run_id TEXT,
    approval_id TEXT,
    message TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX runs_lanes_by_run ON runs_lanes (run_id, created_at)",
  "CREATE INDEX runs_lanes_by_workspace ON runs_lanes (workspace_id)",
];

// JSON columns are written by this module only: the database is inside the boundary.
interface RunRow {
  id: string;
  project_id: string;
  workspace_id: string;
  line: string;
  base: string;
  gates: string;
  coordinator_agent_id: string;
  created_at: number;
}

interface LaneRow {
  id: string;
  run_id: string;
  name: string;
  wave: number;
  depends_on: string;
  brief: string;
  pipeline: string;
  model: string | null;
  state: LaneState;
  workspace_id: string | null;
  pipeline_run_id: string | null;
  approval_id: string | null;
  message: string | null;
  created_at: number;
}

/** The job kind of a lane, keyed by the lane id. */
const LANE_JOB = "runs.lane";

interface LaneSubject {
  laneId: string;
}

/** The approval kind filed when a lane asks for a model above the worker role default (R4.8, ADR 0014). */
const LANE_MODEL = "lane-model";
const LaneModelSubject = Type.Object({ laneId: Type.String() }, { additionalProperties: false });
type LaneModelSubject = Static<typeof LaneModelSubject>;

const DEFAULT_GATES = ["check", "test"];
const DEFAULT_PIPELINE = "default";

const laneToView = (row: LaneRow): Lane => ({
  id: row.id,
  runId: row.run_id,
  name: row.name,
  wave: row.wave,
  dependsOn: JSON.parse(row.depends_on) as string[],
  brief: row.brief,
  pipeline: row.pipeline,
  ...(row.model === null ? {} : { model: row.model }),
  state: row.state,
  ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
  ...(row.message === null ? {} : { message: row.message }),
  createdAt: row.created_at,
});

const runToView = (row: RunRow, lanes: readonly LaneRow[]): Run => ({
  id: row.id,
  projectId: row.project_id,
  workspaceId: row.workspace_id,
  line: row.line,
  base: row.base,
  gates: JSON.parse(row.gates) as string[],
  coordinatorAgentId: row.coordinator_agent_id,
  createdAt: row.created_at,
  lanes: lanes.map(laneToView),
});

const passedMessage = (lane: LaneRow, diffPath: string) =>
  `Lane "${lane.name}" (${lane.id}) passed its pipeline. Its diff is the artifact ${diffPath}. Review it, then call merge_lane to merge it or revise_lane to send it back.`;

const failedMessage = (lane: LaneRow) =>
  [
    `Lane "${lane.name}" (${lane.id}) failed its pipeline.`,
    ...(lane.message ? [lane.message] : []),
    "You can call revise_lane with a new brief to run it again.",
  ].join("\n");

export const runsModule: ServerModule = {
  id: "runs",
  requires: ["projects", "workspaces", "agents", "artifacts", "attention", "actions", "pipelines"],
  core: false,
  setup(host) {
    host.store.migrate("runs", MIGRATIONS);
    const projects = host.use(ProjectsKey);
    const workspaces = host.use(WorkspacesKey);
    const agents = host.use(AgentsKey);
    const artifacts = host.use(ArtifactsKey);
    const approvals = host.use(ApprovalsKey);
    const pipelines = host.use(PipelinesKey);

    const loadRun = (id: string) =>
      host.store.get<RunRow>("SELECT * FROM runs_runs WHERE id = ?", id);
    const requireRun = (id: string): RunRow => {
      const run = loadRun(id);
      if (!run) throw new ApiError(404, "run_not_found", `No run ${id}`);
      return run;
    };
    const runByWorkspace = (workspaceId: string) =>
      host.store.get<RunRow>("SELECT * FROM runs_runs WHERE workspace_id = ?", workspaceId);
    const loadLane = (id: string) =>
      host.store.get<LaneRow>("SELECT * FROM runs_lanes WHERE id = ?", id);
    const lanesOf = (runId: string) =>
      host.store.all<LaneRow>(
        "SELECT * FROM runs_lanes WHERE run_id = ? ORDER BY created_at, id",
        runId,
      );
    const viewOf = (row: RunRow): Run => runToView(row, lanesOf(row.id));

    /** The run of a bridge caller: only a run workspace's agents command a run. */
    const runOfCaller = (caller: BridgeCaller): RunRow => {
      const run = runByWorkspace(caller.workspaceId);
      if (!run) {
        throw new ApiError(
          403,
          "not_coordinator",
          `Workspace ${caller.workspaceId} is not a run workspace`,
        );
      }
      return run;
    };

    const startLaneJob = (laneId: string) =>
      host.jobs.start(LANE_JOB, { laneId } satisfies LaneSubject, { key: laneId });

    const wakeWaiting = (runId: string) => {
      for (const lane of lanesOf(runId)) {
        if (lane.state === "waiting") host.jobs.wake(LANE_JOB, lane.id);
      }
    };

    const integrateOf = async (projectId: string) => {
      const project = await projects.get(projectId);
      const integrate = projects.vcsFor(project).integrate;
      if (!integrate) {
        throw new ApiError(
          422,
          "not_supported",
          `${project.vcs} projects do not support runs: the provider has no integrate capability`,
        );
      }
      return { project, integrate };
    };

    const createRun = async (request: CreateRunRequest): Promise<Run> => {
      const { project, integrate } = await integrateOf(request.projectId);
      const base = request.base ?? (await projects.vcsFor(project).lines?.list(project))?.current;
      if (!base) {
        throw new ApiError(
          422,
          "no_base",
          `${project.name} has no current line to start the run from; give "base"`,
        );
      }
      const id = host.newId();
      const line = `run/${slugify(request.name)}-${id.slice(-6).toLowerCase()}`;
      await integrate.createLine(project, line, base);
      const { workspace } = await workspaces.create({
        projectId: project.id,
        name: request.name,
        isolation: "existing",
        line,
        base,
      });
      const coordinator = await agents.activeWorker(workspace.id);
      host.store.run(
        `INSERT INTO runs_runs (id, project_id, workspace_id, line, base, gates, coordinator_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        project.id,
        workspace.id,
        line,
        base,
        JSON.stringify(request.gates ?? DEFAULT_GATES),
        coordinator.id,
        host.now(),
      );
      return viewOf(requireRun(id));
    };

    /** A brief is an artifact of the run workspace. A missing one is a 404 that names it. */
    const readBrief = async (run: RunRow, path: string): Promise<string> => {
      try {
        const { bytes } = await artifacts.read({ scope: "workspace", id: run.workspace_id }, path);
        return bytes.toString("utf8");
      } catch (error) {
        if (error instanceof ApiError && error.code === "file_not_found") {
          throw new ApiError(
            404,
            "brief_not_found",
            `No brief artifact ${path} in the run workspace`,
          );
        }
        throw error;
      }
    };

    /** The reason a model needs approval (R4.8): its tier is above the worker role default's. Undefined when it does not. */
    const aboveWorkerTier = async (model: string): Promise<string | undefined> => {
      const defaults = await agents.roleDefaults("worker");
      if (!defaults.provider || !defaults.modelId) {
        throw new Error(
          "R4.8 needs the worker model to compare tiers, but the worker role has no default; set the worker model in the pi-subagents settings",
        );
      }
      const worker = `${defaults.provider}/${defaults.modelId}`;
      const settings = await loadSettings(host.home.root);
      const modelTier = tierOf(settings, model);
      const workerTier = tierOf(settings, worker);
      if (TIERS.indexOf(modelTier) <= TIERS.indexOf(workerTier)) return undefined;
      return `${model} is tier ${modelTier}; the worker default ${worker} is tier ${workerTier}`;
    };

    const startLane = async (caller: BridgeCaller, request: StartLaneRequest): Promise<Lane> => {
      const run = runOfCaller(caller);
      await readBrief(run, request.brief);
      const dependsOn = request.dependsOn ?? [];
      const known = new Set(lanesOf(run.id).map((lane) => lane.id));
      const stranger = dependsOn.find((laneId) => !known.has(laneId));
      if (stranger) {
        throw new ApiError(400, "bad_depends_on", `${stranger} is not a lane of run ${run.id}`);
      }
      const higher = request.model ? await aboveWorkerTier(request.model) : undefined;
      const laneId = host.store.transaction(() => {
        const id = host.newId();
        const approval = higher
          ? approvals.file(
              { agentId: run.coordinator_agent_id, workspaceId: run.workspace_id },
              {
                kind: LANE_MODEL,
                title: `Lane "${request.name}" wants model ${request.model}`,
                reason: `R4.8: a lane may use a model above the worker default only with your approval. ${higher}.`,
                subject: { laneId: id },
              },
            )
          : undefined;
        host.store.run(
          `INSERT INTO runs_lanes (id, run_id, name, wave, depends_on, brief, pipeline, model, state, approval_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          run.id,
          request.name,
          request.wave,
          JSON.stringify(dependsOn),
          request.brief,
          request.pipeline ?? DEFAULT_PIPELINE,
          request.model ?? null,
          approval ? "approval" : "waiting",
          approval?.id ?? null,
          host.now(),
        );
        if (!approval) startLaneJob(id);
        return id;
      });
      return laneToView(loadLane(laneId) as LaneRow);
    };

    const reviseLane = async (caller: BridgeCaller, request: ReviseLaneRequest): Promise<Lane> => {
      const run = runOfCaller(caller);
      const lane = loadLane(request.laneId);
      if (lane?.run_id !== run.id) {
        throw new ApiError(404, "lane_not_found", `No lane ${request.laneId} in run ${run.id}`);
      }
      if (lane.state !== "passed" && lane.state !== "failed") {
        throw new ApiError(
          409,
          "lane_not_revisable",
          `Lane ${lane.id} is ${lane.state}; only a passed or failed lane can be revised`,
        );
      }
      await readBrief(run, request.brief);
      host.store.transaction(() => {
        host.store.run(
          "UPDATE runs_lanes SET brief = ?, state = 'starting', message = NULL WHERE id = ?",
          request.brief,
          lane.id,
        );
        startLaneJob(lane.id);
      });
      return laneToView(loadLane(lane.id) as LaneRow);
    };

    approvals.register({
      kind: LANE_MODEL,
      subject: LaneModelSubject,
      // The effects are in `decided`, in the transaction that stores the decision.
      approve: async () => "The lane starts on the approved model when its wave comes.",
      decided: (subject: LaneModelSubject, approval, approved) => {
        const lane = loadLane(subject.laneId);
        // A decision for a lane that has moved on is ignored.
        if (lane?.state !== "approval" || lane.approval_id !== approval.id) return;
        if (approved) {
          host.store.run("UPDATE runs_lanes SET state = 'waiting' WHERE id = ?", lane.id);
          startLaneJob(lane.id);
        } else {
          host.store.run(
            "UPDATE runs_lanes SET state = 'declined', message = ? WHERE id = ?",
            `The user declined the model ${lane.model}`,
            lane.id,
          );
          wakeWaiting(lane.run_id);
        }
      },
    });

    /** A lane waits for every lane of a lower wave and every lane it depends on to merge. A declined lane does not block. */
    const waitsFor = (lane: LaneRow): boolean => {
      const dependsOn = JSON.parse(lane.depends_on) as string[];
      return lanesOf(lane.run_id).some(
        (other) =>
          other.state !== "merged" &&
          other.state !== "declined" &&
          (other.wave < lane.wave || dependsOn.includes(other.id)),
      );
    };

    const ready = async ({ subject }: { subject: LaneSubject }): Promise<StepOutcome<never>> => {
      const lane = loadLane(subject.laneId);
      if (lane?.state === "starting") return {};
      if (lane?.state !== "waiting") return { next: null };
      if (waitsFor(lane)) return { wait: true };
      const run = requireRun(lane.run_id);
      const { workspace } = await workspaces.create({
        projectId: run.project_id,
        name: lane.name,
        isolation: "new",
        base: run.line,
      });
      return {
        commit: () =>
          host.store.run(
            "UPDATE runs_lanes SET workspace_id = ?, state = 'starting' WHERE id = ?",
            workspace.id,
            lane.id,
          ),
      };
    };

    const launch = async ({ subject }: { subject: LaneSubject }): Promise<StepOutcome<never>> => {
      const lane = loadLane(subject.laneId);
      if (lane?.state !== "starting") return { next: lane ? "await" : null };
      const run = requireRun(lane.run_id);
      const brief = await readBrief(run, lane.brief);
      let pipelineRunId: string | undefined;
      try {
        const started = await pipelines.start(lane.workspace_id as string, {
          pipeline: lane.pipeline,
          brief,
          askingAgentId: run.coordinator_agent_id,
          ...(lane.model ? { workerModel: lane.model } : {}),
        });
        pipelineRunId = started.id;
      } catch (error) {
        // A step cut off by a restart already started the run.
        if (!(error instanceof ApiError && error.code === "pipeline_running")) throw error;
      }
      return {
        commit: () =>
          host.store.run(
            "UPDATE runs_lanes SET state = 'running', pipeline_run_id = COALESCE(?, pipeline_run_id) WHERE id = ? AND state = 'starting'",
            pipelineRunId ?? null,
            lane.id,
          ),
      };
    };

    const awaitPipeline = async ({
      subject,
    }: {
      subject: LaneSubject;
    }): Promise<StepOutcome<never>> =>
      loadLane(subject.laneId)?.state === "running" ? { wait: true } : {};

    const report = async ({ subject }: { subject: LaneSubject }): Promise<StepOutcome<never>> => {
      const lane = loadLane(subject.laneId);
      if (lane?.state !== "passed" && lane?.state !== "failed") return { next: null };
      const run = requireRun(lane.run_id);
      if (lane.state === "failed") {
        return {
          next: null,
          commit: () => agents.deliver(run.coordinator_agent_id, failedMessage(lane)),
        };
      }
      const { integrate } = await integrateOf(run.project_id);
      const runWorkspace = workspaces.get(run.workspace_id);
      const laneWorkspace = workspaces.get(lane.workspace_id as string);
      const diff = await integrate.diff(
        { path: runWorkspace.path, line: run.line },
        laneWorkspace.line as string,
      );
      const path = `runs/${run.id}/lanes/${lane.id}.diff`;
      await artifacts.write({ scope: "workspace", id: run.workspace_id }, path, diff);
      return {
        next: null,
        commit: () => agents.deliver(run.coordinator_agent_id, passedMessage(lane, path)),
      };
    };

    const steps: JobStep<LaneSubject, never>[] = [
      { name: "ready", run: ready },
      { name: "launch", run: launch },
      { name: "await", run: awaitPipeline },
      { name: "report", run: report },
    ];
    host.jobs.define(LANE_JOB, steps);

    // Runs inside the transaction that ends the pipeline run, so the lane and the run never disagree. A run may end
    // before `launch` commits `running`, so a starting lane counts too.
    pipelines.afterRunEnded((ended) => {
      const lane = host.store.get<LaneRow>(
        "SELECT * FROM runs_lanes WHERE workspace_id = ? AND state IN ('starting', 'running')",
        ended.workspaceId,
      );
      if (!lane) return;
      host.store.run(
        "UPDATE runs_lanes SET state = ?, message = ? WHERE id = ?",
        ended.state === "passed" ? "passed" : "failed",
        ended.message ?? null,
        lane.id,
      );
      host.jobs.wake(LANE_JOB, lane.id);
    });

    agents.addLaunchContext((agent, workspace) => {
      const run = runByWorkspace(workspace.id);
      if (run) {
        return agent.kind === "worker"
          ? {
              env: { PI_SPORE_RUN_ID: run.id, PI_SPORE_RUN_ROLE: "coordinator" },
              tools: COORDINATOR_TOOLS,
            }
          : undefined;
      }
      const lane = host.store.get<LaneRow>(
        "SELECT * FROM runs_lanes WHERE workspace_id = ?",
        workspace.id,
      );
      return lane
        ? { env: { PI_SPORE_RUN_ID: lane.run_id, PI_SPORE_RUN_ROLE: "lane" } }
        : undefined;
    });

    const api: Runs = {
      startLane,
      reviseLane,
      laneOf: (workspaceId) => {
        const lane = host.store.get<LaneRow>(
          "SELECT * FROM runs_lanes WHERE workspace_id = ?",
          workspaceId,
        );
        return lane ? { runId: lane.run_id, laneId: lane.id } : undefined;
      },
      runOf: (workspaceId) => {
        const run = runByWorkspace(workspaceId);
        return run ? viewOf(run) : undefined;
      },
    };
    host.provide(RunsKey, api);

    host.routes.get("/", (c) => {
      const projectId = c.req.query("projectId");
      const rows = projectId
        ? host.store.all<RunRow>(
            "SELECT * FROM runs_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC",
            projectId,
          )
        : host.store.all<RunRow>("SELECT * FROM runs_runs ORDER BY created_at DESC, id DESC");
      return c.json({ runs: rows.map(viewOf) });
    });

    host.routes.post("/", async (c) => {
      const request = parseJsonBody(CreateRunRequest, await c.req.text(), "run request");
      return c.json({ run: await createRun(request) }, 201);
    });

    host.routes.get("/:id", (c) => c.json({ run: viewOf(requireRun(c.req.param("id"))) }));
  },
};
