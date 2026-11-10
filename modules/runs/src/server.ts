import { ActionsKey } from "@pi-spore/mod-actions/server";
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
  type AnswerLaneRequest,
  type Approval,
  type AskCoordinatorRequest,
  CreateRunRequest,
  type Lane,
  type LaneState,
  type LaneStatus,
  type MergeLaneRequest,
  type OpenRunPrRequest,
  type PipelineStage,
  parseJsonBody,
  type ReviseLaneRequest,
  type Run,
  type RunEvent,
  RunPrSubject,
  type RunQuestion,
  type RunState,
  type RunStatus,
  type StartLaneRequest,
  slugify,
} from "@pi-spore/shared";
import Type, { type Static } from "typebox";
import { type Runs, RunsKey } from "./contract.js";

export * from "./contract.js";

/**
 * The coordinator's tools (ADR 0150, ADR 0154): read tools, artifacts, questions, the run tools, and the kanban tools
 * that list and add cards. No write or shell tool, and no tool that changes or starts a card.
 */
export const COORDINATOR_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "request_human_input",
  "artifacts_list",
  "artifacts_read",
  "artifacts_write",
  "kanban_list_cards",
  "kanban_add_card",
  "start_lane",
  "revise_lane",
  "merge_lane",
  "answer_lane",
  "open_run_pr",
  "run_status",
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
  `CREATE TABLE runs_questions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    lane_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  )`,
  "ALTER TABLE runs_runs ADD COLUMN state TEXT NOT NULL DEFAULT 'running'",
  "ALTER TABLE runs_runs ADD COLUMN pr_approval_id TEXT",
];

// JSON columns are written by this module only: the database is inside the boundary.
interface RunRow {
  id: string;
  project_id: string;
  workspace_id: string;
  line: string;
  base: string;
  gates: string;
  state: RunState;
  coordinator_agent_id: string;
  pr_approval_id: string | null;
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

interface QuestionRow {
  id: string;
  run_id: string;
  lane_id: string;
  agent_id: string;
  question: string;
  answer: string | null;
  state: RunQuestion["state"];
  created_at: number;
}

/** The only topic: every run, newest first. */
const RUNS_TOPIC = "runs:list";

/** The job kind of a lane, keyed by the lane id. */
const LANE_JOB = "runs.lane";

interface LaneSubject {
  laneId: string;
}

/** The job kind of a lane merge, keyed by the run id so the merges of one run go one at a time, in order. */
const MERGE_JOB = "runs.merge";

const NOT_ENDED = ["running", "waiting", "interrupted"] as const;

/** `gate` and `attempt` are the place in the run's gates; `failure` is the first gate that failed, for `finish`. */
interface MergeCheckpoint {
  gate: number;
  attempt: number;
  failure?: { action: string; logTail: string };
}

/** How much of a failed gate's log goes to the coordinator. */
const LOG_TAIL_CHARS = 4096;

/** The approval kind filed when a lane asks for a model above the worker role default (R4.8, ADR 0014). */
const LANE_MODEL = "lane-model";
const LaneModelSubject = Type.Object({ laneId: Type.String() }, { additionalProperties: false });
type LaneModelSubject = Static<typeof LaneModelSubject>;

/** The approval kind filed when the coordinator asks to open the run's PR (ADR 0100, ADR 0130). */
const RUN_PR = "run-pr";

const DEFAULT_GATES = ["check", "test"];
const DEFAULT_PIPELINE = "default";

/** `blocked` comes from the lane's pipeline run, which the pipelines module owns. */
const laneToView = (row: LaneRow, blocked: string | undefined): Lane => ({
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
  ...(row.pipeline_run_id === null ? {} : { pipelineRunId: row.pipeline_run_id }),
  ...(blocked === undefined ? {} : { blocked }),
  createdAt: row.created_at,
});

const questionToView = (row: QuestionRow): RunQuestion => ({
  id: row.id,
  runId: row.run_id,
  laneId: row.lane_id,
  agentId: row.agent_id,
  question: row.question,
  ...(row.answer === null ? {} : { answer: row.answer }),
  state: row.state,
  createdAt: row.created_at,
});

const runToView = (row: RunRow, lanes: Lane[], questions: readonly QuestionRow[]): Run => ({
  id: row.id,
  projectId: row.project_id,
  workspaceId: row.workspace_id,
  line: row.line,
  base: row.base,
  gates: JSON.parse(row.gates) as string[],
  state: row.state,
  coordinatorAgentId: row.coordinator_agent_id,
  createdAt: row.created_at,
  lanes,
  questions: questions.map(questionToView),
});

const questionMessage = (lane: LaneRow, question: QuestionRow) =>
  [
    `Lane "${lane.name}" (${lane.id}) asks (question ${question.id}):`,
    question.question,
    "Answer it from the spec with answer_lane. If the spec does not say, ask the user with request_human_input first, then answer.",
  ].join("\n");

const answerMessage = (question: QuestionRow, answer: string) =>
  [
    `Your coordinator answered your question ${question.id}.`,
    `Question: ${question.question}`,
    `Answer: ${answer}`,
  ].join("\n");

const passedMessage = (lane: LaneRow, diffPath: string) =>
  `Lane "${lane.name}" (${lane.id}) passed its pipeline. Its diff is the artifact ${diffPath}. Review it, then call merge_lane to merge it or revise_lane to send it back.`;

const failedMessage = (lane: LaneRow) =>
  [
    `Lane "${lane.name}" (${lane.id}) failed its pipeline.`,
    ...(lane.message ? [lane.message] : []),
    "You can call revise_lane with a new brief to run it again.",
  ].join("\n");

const workerGoneMessage = (lane: LaneRow) =>
  `Lane "${lane.name}" (${lane.id}): its worker chat is gone, so the revise runs the full pipeline "${lane.pipeline}" with a new worker.`;

/** The built-in pipeline that gives a revise brief to the lane's own worker chat (ADR 0158). */
const REVISE_PIPELINE = "revise";

const conflictMessage = (lane: LaneRow, line: string, files: readonly string[]) =>
  [
    `Lane "${lane.name}" (${lane.id}) conflicts with ${line} in: ${files.join(", ")}.`,
    `The run line did not move. You can call revise_lane with a brief that tells the lane to merge ${line} into its branch and resolve these files.`,
  ].join("\n");

const gateFailedMessage = (
  lane: LaneRow,
  failure: { action: string; logTail: string },
  diffPath: string,
) =>
  [
    `Lane "${lane.name}" (${lane.id}) merged, but the gate ${failure.action} failed on the merged tree. The run line did not move.`,
    `The lane's diff is the artifact ${diffPath}. The end of the gate log:`,
    failure.logTail,
    "You can call revise_lane with a new brief to fix it.",
  ].join("\n");

/** What the lane diff artifact is called once a lane has passed; `report` and `merge` write it. */
const laneDiffPath = (runId: string, laneId: string) => `runs/${runId}/lanes/${laneId}.diff`;

const HAS_LANE_DIFF: readonly LaneState[] = ["passed", "merging", "merged"];

const handoverMessage = (
  run: RunRow,
  runName: string,
  lanes: readonly LaneRow[],
  questions: readonly (QuestionRow & { laneName: string })[],
) =>
  [
    `The user started a new chat. This chat is now the coordinator of the run "${runName}" (${run.id}).`,
    `The run line is ${run.line}. Its base is ${run.base}.${run.state === "finished" ? " Its PR is open." : ""}`,
    lanes.length === 0 ? "The run has no lanes yet." : "The lanes:",
    ...lanes.map(
      (lane) =>
        `- "${lane.name}" (${lane.id}), wave ${lane.wave}, ${lane.state}, brief ${lane.brief}${
          HAS_LANE_DIFF.includes(lane.state) ? `, diff ${laneDiffPath(run.id, lane.id)}` : ""
        }`,
    ),
    ...(questions.length === 0
      ? ["No lane question is open."]
      : [
          "Open lane questions. Answer each with answer_lane:",
          ...questions.map(
            (question) =>
              `- ${question.id}: lane "${question.laneName}" asks: ${question.question}`,
          ),
        ]),
    "Messages for the old chat follow.",
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
    const actions = host.use(ActionsKey);
    let openPr: Parameters<Runs["setPrOpener"]>[0] | undefined;

    const loadRun = (id: string) =>
      host.store.get<RunRow>("SELECT * FROM runs_runs WHERE id = ?", id);
    const requireRun = (id: string): RunRow => {
      const run = loadRun(id);
      if (!run) throw new ApiError(404, "run_not_found", `No run ${id}`);
      return run;
    };
    // A job step's commit reads it again: the user may have started a new coordinator chat during the step's async work.
    const coordinatorOf = (runId: string) => requireRun(runId).coordinator_agent_id;
    const runByWorkspace = (workspaceId: string) =>
      host.store.get<RunRow>("SELECT * FROM runs_runs WHERE workspace_id = ?", workspaceId);
    const loadLane = (id: string) =>
      host.store.get<LaneRow>("SELECT * FROM runs_lanes WHERE id = ?", id);
    const laneByWorkspace = (workspaceId: string) =>
      host.store.get<LaneRow>("SELECT * FROM runs_lanes WHERE workspace_id = ?", workspaceId);
    const loadQuestion = (id: string) =>
      host.store.get<QuestionRow>("SELECT * FROM runs_questions WHERE id = ?", id);
    const lanesOf = (runId: string) =>
      host.store.all<LaneRow>(
        "SELECT * FROM runs_lanes WHERE run_id = ? ORDER BY created_at, id",
        runId,
      );
    const openQuestionsOf = (runId: string) =>
      host.store.all<QuestionRow>(
        "SELECT * FROM runs_questions WHERE run_id = ? AND state = 'open' ORDER BY created_at, id",
        runId,
      );
    const blockedOf = (lane: LaneRow) =>
      lane.pipeline_run_id === null ? undefined : pipelines.get(lane.pipeline_run_id).blocked;
    const laneView = (lane: LaneRow) => laneToView(lane, blockedOf(lane));
    const viewOf = (row: RunRow): Run =>
      runToView(row, lanesOf(row.id).map(laneView), openQuestionsOf(row.id));
    const allRuns = (): Run[] =>
      host.store
        .all<RunRow>("SELECT * FROM runs_runs ORDER BY created_at DESC, id DESC")
        .map(viewOf);

    const publish = () => {
      const event: RunEvent = { type: "runs", runs: allRuns() };
      host.events.publish(RUNS_TOPIC, event);
    };
    // A change made inside someone else's transaction publishes after it ends: the transaction is synchronous, so
    // the microtask runs after the commit.
    const publishAfterCommit = () => queueMicrotask(publish);
    host.events.onSubscribe(RUNS_TOPIC, () => {
      const event: RunEvent = { type: "runs", runs: allRuns() };
      return [event];
    });
    // Job steps move lanes on; the browser sees it here.
    host.jobs.onChange((job) => {
      if (job.kind === LANE_JOB || job.kind === MERGE_JOB) publish();
    });

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
      if (run.state === "cancelled") {
        throw new ApiError(409, "run_cancelled", `Run ${run.id} is cancelled`);
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

    const createRun = async (
      request: CreateRunRequest,
      { model }: { model?: string } = {},
    ): Promise<Run> => {
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
      const coordinator = await agents.activeWorker(
        workspace.id,
        model === undefined ? {} : { model },
      );
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
      publish();
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
      publish();
      return laneView(loadLane(laneId) as LaneRow);
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
      publish();
      return laneView(loadLane(lane.id) as LaneRow);
    };

    const mergeLane = async (caller: BridgeCaller, request: MergeLaneRequest): Promise<Lane> => {
      const run = runOfCaller(caller);
      const lane = loadLane(request.laneId);
      if (lane?.run_id !== run.id) {
        throw new ApiError(404, "lane_not_found", `No lane ${request.laneId} in run ${run.id}`);
      }
      if (lane.state !== "passed") {
        throw new ApiError(
          409,
          "lane_not_mergeable",
          `Lane ${lane.id} is ${lane.state}; only a passed lane can be merged`,
        );
      }
      host.store.transaction(() => {
        host.store.run(
          "UPDATE runs_lanes SET state = 'merging', message = NULL WHERE id = ?",
          lane.id,
        );
        host.jobs.start(MERGE_JOB, { laneId: lane.id } satisfies LaneSubject, { key: run.id });
      });
      publish();
      return laneView(loadLane(lane.id) as LaneRow);
    };

    const askCoordinator = (caller: BridgeCaller, request: AskCoordinatorRequest): RunQuestion => {
      const lane = laneByWorkspace(caller.workspaceId);
      if (!lane) {
        throw new ApiError(
          403,
          "not_in_lane",
          `Workspace ${caller.workspaceId} is not a lane; only lane agents ask a coordinator`,
        );
      }
      const run = requireRun(lane.run_id);
      const id = host.newId();
      const asked = host.store.transaction(() => {
        host.store.run(
          `INSERT INTO runs_questions (id, run_id, lane_id, agent_id, question, state, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?)`,
          id,
          run.id,
          lane.id,
          caller.agentId,
          request.question,
          host.now(),
        );
        const row = loadQuestion(id) as QuestionRow;
        agents.deliver(run.coordinator_agent_id, questionMessage(lane, row));
        return questionToView(row);
      });
      publish();
      return asked;
    };

    const answerLane = (caller: BridgeCaller, request: AnswerLaneRequest): RunQuestion => {
      const run = runOfCaller(caller);
      const question = loadQuestion(request.questionId);
      if (question?.run_id !== run.id) {
        throw new ApiError(
          404,
          "question_not_found",
          `No question ${request.questionId} in run ${run.id}`,
        );
      }
      if (question.state !== "open") {
        throw new ApiError(409, "question_answered", `Question ${question.id} has an answer`);
      }
      const answered = host.store.transaction(() => {
        host.store.run(
          "UPDATE runs_questions SET answer = ?, state = 'answered', answered_at = ? WHERE id = ?",
          request.answer,
          host.now(),
          question.id,
        );
        agents.deliver(question.agent_id, answerMessage(question, request.answer));
        return questionToView(loadQuestion(question.id) as QuestionRow);
      });
      publish();
      return answered;
    };

    const requestPr = (caller: BridgeCaller, request: OpenRunPrRequest): Approval => {
      const run = runOfCaller(caller);
      if (run.state === "finished") {
        throw new ApiError(409, "run_finished", `The PR of run ${run.id} is open`);
      }
      const lanes = lanesOf(run.id);
      const open = lanes.find((lane) => lane.state !== "merged" && lane.state !== "declined");
      if (open || !lanes.some((lane) => lane.state === "merged")) {
        throw new ApiError(
          409,
          "run_not_finished",
          open
            ? `Lane "${open.name}" (${open.id}) is ${open.state}; every lane must be merged or declined`
            : "No lane is merged yet",
        );
      }
      if (run.pr_approval_id) {
        throw new ApiError(
          409,
          "run_pr_asked",
          `Approval ${run.pr_approval_id} already asks the user to open the PR of run ${run.id}`,
        );
      }
      const approval = host.store.transaction(() => {
        const filed = approvals.file(caller, {
          kind: RUN_PR,
          title: `Open the PR of run "${workspaces.get(run.workspace_id).name}"`,
          reason:
            "Opening a PR sends the run's branch and this text to GitHub. pi-spore never merges it; a human does (ADR 0130).",
          subject: {
            runId: run.id,
            title: request.title,
            body: request.body,
            base: run.base,
            head: run.line,
          } satisfies RunPrSubject,
        });
        host.store.run("UPDATE runs_runs SET pr_approval_id = ? WHERE id = ?", filed.id, run.id);
        return filed;
      });
      publish();
      return approval;
    };

    approvals.register({
      kind: RUN_PR,
      subject: RunPrSubject,
      approve: async (subject, approval) => {
        const filed = approval.subject as RunPrSubject;
        if (
          subject.runId !== filed.runId ||
          subject.base !== filed.base ||
          subject.head !== filed.head
        ) {
          throw new ApiError(
            422,
            "approval_run_changed",
            "Approve can change the title and body, not the run, base, or head",
          );
        }
        const run = requireRun(subject.runId);
        if (run.state === "cancelled") {
          throw new ApiError(409, "run_cancelled", `Run ${run.id} is cancelled`);
        }
        if (!openPr) {
          throw new ApiError(
            409,
            "pr_not_supported",
            "No module opens pull requests: enable the github-pr module",
          );
        }
        const pr = await openPr(run.workspace_id, {
          title: subject.title,
          body: subject.body,
          base: run.base,
        });
        return `Opened PR #${pr.number} (${pr.url}) from ${run.line} into ${run.base}. A human merges it; pi-spore never merges it and never turns on auto-merge.`;
      },
      decided: (subject, approval, approved) => {
        const run = loadRun(subject.runId);
        if (run?.pr_approval_id !== approval.id) return;
        host.store.run(
          approved
            ? "UPDATE runs_runs SET pr_approval_id = NULL, state = 'finished' WHERE id = ?"
            : "UPDATE runs_runs SET pr_approval_id = NULL WHERE id = ?",
          run.id,
        );
        publishAfterCommit();
      },
    });

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
        publishAfterCommit();
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

    /** False when retention deleted the chat (404) or the user closed it (ADR 0110). */
    const workerPresent = (agentId: string): boolean => {
      try {
        return !agents.isClosed(agentId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return false;
        throw error;
      }
    };

    const launch = async ({ subject }: { subject: LaneSubject }): Promise<StepOutcome<never>> => {
      const lane = loadLane(subject.laneId);
      if (lane?.state !== "starting") return { next: lane ? "await" : null };
      const run = requireRun(lane.run_id);
      const brief = await readBrief(run, lane.brief);
      // A lane that ran before is a revise. It needs its last run's worker chat, so a deleted or closed one is gone.
      const worker = lane.pipeline_run_id
        ? pipelines.get(lane.pipeline_run_id).workerAgentId
        : undefined;
      const reuse = worker !== undefined && workerPresent(worker);
      let pipelineRunId: string | undefined;
      try {
        const started = await pipelines.start(lane.workspace_id as string, {
          brief,
          askingAgentId: run.coordinator_agent_id,
          ...(reuse
            ? { pipeline: REVISE_PIPELINE, previousRunId: lane.pipeline_run_id as string }
            : { pipeline: lane.pipeline, ...(lane.model ? { workerModel: lane.model } : {}) }),
        });
        pipelineRunId = started.id;
      } catch (error) {
        // A step cut off by a restart already started the run.
        if (!(error instanceof ApiError && error.code === "pipeline_running")) throw error;
      }
      // A cancel that landed during the start found no pipeline run to stop, and its job writes nothing now.
      if (pipelineRunId && loadLane(lane.id)?.state === "cancelled") {
        const laneAgents = agents.inWorkspace(lane.workspace_id as string);
        host.store.transaction(() => {
          pipelines.stop(pipelineRunId, "Cancelled with the run");
          for (const agent of laneAgents) agents.dropDeliveries(agent.id);
        });
        for (const agent of laneAgents) await agents.stop(agent.id);
        return { next: null };
      }
      return {
        commit: () => {
          host.store.run(
            "UPDATE runs_lanes SET state = 'running', pipeline_run_id = COALESCE(?, pipeline_run_id) WHERE id = ? AND state = 'starting'",
            pipelineRunId ?? null,
            lane.id,
          );
          // Only the step that started the run tells, so a restart does not send it twice.
          if (pipelineRunId && lane.pipeline_run_id && !reuse) {
            agents.deliver(coordinatorOf(run.id), workerGoneMessage(lane));
          }
        },
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
          commit: () => agents.deliver(coordinatorOf(run.id), failedMessage(lane)),
        };
      }
      const { integrate } = await integrateOf(run.project_id);
      const runWorkspace = workspaces.get(run.workspace_id);
      const laneWorkspace = workspaces.get(lane.workspace_id as string);
      const diff = await integrate.diff(
        { path: runWorkspace.path, line: run.line },
        laneWorkspace.line as string,
      );
      const path = laneDiffPath(run.id, lane.id);
      await artifacts.write({ scope: "workspace", id: run.workspace_id }, path, diff);
      return {
        next: null,
        commit: () => agents.deliver(coordinatorOf(run.id), passedMessage(lane, path)),
      };
    };

    const steps: JobStep<LaneSubject, never>[] = [
      { name: "ready", run: ready },
      { name: "launch", run: launch },
      { name: "await", run: awaitPipeline },
      { name: "report", run: report },
    ];
    host.jobs.define(LANE_JOB, steps);

    // A lane's pipeline run can block or clear without a lane job change; the Runs page sees it here.
    pipelines.onChange((workspaceId) => {
      if (laneByWorkspace(workspaceId)) publishAfterCommit();
    });

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
      publishAfterCommit();
    });

    /** The run's worktree and the lane's branch: where a merge happens, and what it merges. */
    const mergeSite = async (run: RunRow, lane: LaneRow) => {
      const { project, integrate } = await integrateOf(run.project_id);
      return {
        project,
        integrate,
        location: { path: workspaces.get(run.workspace_id).path, line: run.line },
        laneLine: workspaces.get(lane.workspace_id as string).line as string,
      };
    };

    const mergingLane = (subject: LaneSubject): LaneRow | undefined => {
      const lane = loadLane(subject.laneId);
      return lane?.state === "merging" ? lane : undefined;
    };

    const merge = async ({ subject }: { subject: LaneSubject }): Promise<StepOutcome<never>> => {
      const lane = mergingLane(subject);
      if (!lane) return { next: null };
      const run = requireRun(lane.run_id);
      const { integrate, location, laneLine } = await mergeSite(run, lane);
      // A restart may have left an earlier try of this merge in progress.
      await integrate.abort(location);
      const { conflicts } = await integrate.merge(location, laneLine);
      // A cancel that landed during the merge has already run its own abort, before this merge touched the tree.
      if (!mergingLane(subject)) {
        await integrate.abort(location);
        return { next: null };
      }
      if (conflicts.length === 0) return {};
      return {
        next: null,
        commit: () => {
          host.store.run(
            "UPDATE runs_lanes SET state = 'passed', message = ? WHERE id = ?",
            `merge conflict in ${conflicts.join(", ")}`,
            lane.id,
          );
          agents.deliver(coordinatorOf(run.id), conflictMessage(lane, run.line, conflicts));
        },
      };
    };

    /** The action run of each run's gate that is running now, so a cancel can end it. A restart interrupts it anyway. */
    const gateActions = new Map<string, string>();

    /**
     * Runs the gate at the checkpoint's place on the merged tree. The key holds the job id, which is new for each
     * `mergeLane` call, so a lane merged again after a revise runs its gates again, while a step that runs again after
     * a restart gets the same action run back.
     */
    const gate = async ({
      id,
      subject,
      checkpoint,
    }: {
      id: string;
      subject: LaneSubject;
      checkpoint: MergeCheckpoint | undefined;
    }): Promise<StepOutcome<MergeCheckpoint>> => {
      const lane = mergingLane(subject);
      if (!lane) return { next: null };
      const run = requireRun(lane.run_id);
      const gates = JSON.parse(run.gates) as string[];
      const index = checkpoint?.gate ?? 0;
      const attempt = checkpoint?.attempt ?? 0;
      const action = gates[index] as string;
      const started = await actions.start(run.workspace_id, action, "pipeline", {
        key: `${run.id}:${lane.id}:${id}:${action}:${attempt}`,
      });
      gateActions.set(run.id, started.id);
      const ended = await actions.wait(started.id).finally(() => gateActions.delete(run.id));
      if (ended.status === "interrupted") {
        return { next: "gate", checkpoint: { gate: index, attempt: attempt + 1 } };
      }
      if (ended.status === "succeeded") {
        return index + 1 < gates.length
          ? { next: "gate", checkpoint: { gate: index + 1, attempt: 0 } }
          : { next: "finish" };
      }
      const { text } = await actions.readLog(ended.id, undefined);
      const logTail = [ended.error, text.slice(-LOG_TAIL_CHARS)].filter(Boolean).join("\n");
      return {
        next: "finish",
        checkpoint: { gate: index, attempt, failure: { action, logTail } },
      };
    };

    const finish = async ({
      subject,
      checkpoint,
    }: {
      subject: LaneSubject;
      checkpoint: MergeCheckpoint | undefined;
    }): Promise<StepOutcome<never>> => {
      const lane = mergingLane(subject);
      if (!lane) return { next: null };
      const run = requireRun(lane.run_id);
      const { project, integrate, location, laneLine } = await mergeSite(run, lane);
      const failure = checkpoint?.failure;
      if (failure) {
        const path = `runs/${run.id}/lanes/${lane.id}-gates.diff`;
        await artifacts.write(
          { scope: "workspace", id: run.workspace_id },
          path,
          await integrate.diff(location, laneLine),
        );
        await integrate.abort(location);
        return {
          next: null,
          commit: () => {
            host.store.run(
              "UPDATE runs_lanes SET state = 'passed', message = ? WHERE id = ?",
              `gate ${failure.action} failed`,
              lane.id,
            );
            agents.deliver(coordinatorOf(run.id), gateFailedMessage(lane, failure, path));
          },
        };
      }
      // A cancel that landed during the last gate has aborted the merge; committing now would merge a cancelled lane.
      if (!mergingLane(subject)) {
        await integrate.abort(location);
        return { next: null };
      }
      // After a restart the commit may already be made. Then the lane adds nothing to the run line, and a second
      // commit would fail on an empty merge.
      if ((await integrate.diff(location, laneLine)) !== "") {
        await integrate.commit(location, `Merge lane ${lane.name} (${lane.id})`);
      }
      // ADR 0165: the user approved this branch on GitHub with the run PR, so each green merge goes to it. A failed
      // push leaves the lane merged and goes into the message.
      let pushError: string | undefined;
      if (run.state === "finished") {
        try {
          const publish = projects.vcsFor(project).publish;
          if (!publish) {
            throw new ApiError(
              422,
              "not_supported",
              `${project.vcs} projects do not support publish: the provider has no publish capability`,
            );
          }
          await publish.push(location, run.line);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          pushError = `${error.code}: ${error.message}`;
        }
      }
      const tail =
        run.state !== "finished"
          ? [
              "All lanes of the run are merged or declined. Call open_run_pr with a title and a body to ask the user to open the run's one PR. pi-spore never merges to the base line.",
            ]
          : pushError === undefined
            ? [`pi-spore pushed ${run.line}. The run's PR is open and now shows this merge.`]
            : [
                `pi-spore could not push ${run.line}: ${pushError}`,
                "The run's PR does not show this merge. Tell the user.",
              ];
      return {
        next: null,
        commit: () => {
          host.store.run(
            "UPDATE runs_lanes SET state = 'merged', message = NULL WHERE id = ?",
            lane.id,
          );
          wakeWaiting(run.id);
          const done = lanesOf(run.id).every(
            (other) => other.state === "merged" || other.state === "declined",
          );
          agents.deliver(
            coordinatorOf(run.id),
            [
              `Lane "${lane.name}" (${lane.id}) is merged into ${run.line}. The gates passed on the merged tree.`,
              ...(run.state === "finished" || done ? tail : []),
            ].join("\n"),
          );
        },
      };
    };

    host.jobs.define(MERGE_JOB, [
      { name: "merge", run: merge },
      { name: "gate", run: gate },
      { name: "finish", run: finish },
    ] satisfies JobStep<LaneSubject, MergeCheckpoint>[]);

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
      const lane = laneByWorkspace(workspace.id);
      return lane
        ? { env: { PI_SPORE_RUN_ID: lane.run_id, PI_SPORE_RUN_ROLE: "lane" } }
        : undefined;
    });

    // A new or reactivated worker chat takes over the run (ADR 0030: the old chat is read-only history). A finished
    // run too, as its PR can need more lanes, whose reports must reach a chat that runs (ADR 0157). A cancelled run
    // keeps its coordinator.
    agents.afterWorkerChange((agent) => {
      const run = runByWorkspace(agent.workspaceId);
      if (!run || run.state === "cancelled" || run.coordinator_agent_id === agent.id) return;
      const lanes = lanesOf(run.id);
      const questions = openQuestionsOf(run.id).map((question) => ({
        ...question,
        laneName: lanes.find((lane) => lane.id === question.lane_id)?.name as string,
      }));
      host.store.transaction(() => {
        host.store.run(
          "UPDATE runs_runs SET coordinator_agent_id = ? WHERE id = ?",
          agent.id,
          run.id,
        );
        // The handover goes first, so the old chat's unsent messages follow it in order.
        agents.deliver(
          agent.id,
          handoverMessage(run, workspaces.get(run.workspace_id).name, lanes, questions),
        );
        agents.moveDeliveries(run.coordinator_agent_id, agent.id);
      });
      publish();
    });

    /** Stops a run (ADR 0150). It deletes nothing and never merges, pushes, or opens a PR. */
    const cancelRun = async (id: string): Promise<Run> => {
      const run = requireRun(id);
      if (run.state === "cancelled") return viewOf(run);
      const lanes = lanesOf(id);
      const agentIds = [
        run.coordinator_agent_id,
        ...lanes.flatMap((lane) =>
          lane.workspace_id ? agents.inWorkspace(lane.workspace_id).map((agent) => agent.id) : [],
        ),
      ];
      const cancelJobs = (kind: string, key: string) => {
        for (const job of host.jobs.list({ kind, key, states: NOT_ENDED }))
          host.jobs.cancel(job.id);
      };
      host.store.transaction(() => {
        host.store.run("UPDATE runs_runs SET state = 'cancelled' WHERE id = ?", id);
        for (const lane of lanes) {
          if (lane.state === "merged") continue;
          host.store.run(
            "UPDATE runs_lanes SET state = 'cancelled', message = 'Cancelled with the run' WHERE id = ?",
            lane.id,
          );
          cancelJobs(LANE_JOB, lane.id);
        }
        cancelJobs(MERGE_JOB, id);
        // The lanes are cancelled first, so `afterRunEnded` finds no starting or running lane to change.
        for (const lane of lanes) {
          if ((lane.state !== "starting" && lane.state !== "running") || !lane.pipeline_run_id) {
            continue;
          }
          try {
            pipelines.stop(lane.pipeline_run_id, "Cancelled with the run");
          } catch (error) {
            if (!(error instanceof ApiError && error.code === "run_ended")) throw error;
          }
        }
        for (const agentId of agentIds) agents.dropDeliveries(agentId);
      });
      publish();
      const gateAction = gateActions.get(id);
      if (gateAction) actions.cancel(gateAction);
      for (const agentId of agentIds) await agents.stop(agentId);
      const { integrate } = await integrateOf(run.project_id);
      await integrate.abort({ path: workspaces.get(run.workspace_id).path, line: run.line });
      return viewOf(requireRun(id));
    };

    const status = (caller: BridgeCaller, runId: string): RunStatus => {
      const run = requireRun(runId);
      const lanes = lanesOf(run.id);
      if (
        caller.workspaceId !== run.workspace_id &&
        !lanes.some((lane) => lane.workspace_id === caller.workspaceId)
      ) {
        throw new ApiError(
          403,
          "not_in_run",
          `Workspace ${caller.workspaceId} is not run ${run.id} or one of its lanes`,
        );
      }
      return {
        runId: run.id,
        name: workspaces.get(run.workspace_id).name,
        state: run.state,
        lanes: lanes.map((lane): LaneStatus => {
          const pipelineRun =
            lane.pipeline_run_id === null ? undefined : pipelines.get(lane.pipeline_run_id);
          const rounds = (pipelineRun?.turns ?? [])
            .filter((turn) => turn.stageIndex === pipelineRun?.stageIndex)
            .map((turn) => turn.round);
          return {
            id: lane.id,
            name: lane.name,
            wave: lane.wave,
            state: lane.state,
            ...(lane.workspace_id === null
              ? {}
              : { workspace: workspaces.get(lane.workspace_id).name }),
            ...(pipelineRun
              ? { stage: (pipelineRun.stages[pipelineRun.stageIndex] as PipelineStage).name }
              : {}),
            ...(rounds.length === 0 ? {} : { round: Math.max(...rounds) }),
            ...(pipelineRun?.blocked === undefined ? {} : { blocked: pipelineRun.blocked }),
            ...(lane.message === null ? {} : { message: lane.message }),
            ...(HAS_LANE_DIFF.includes(lane.state) ? { diff: laneDiffPath(run.id, lane.id) } : {}),
          };
        }),
      };
    };

    const api: Runs = {
      create: createRun,
      startLane,
      reviseLane,
      mergeLane,
      askCoordinator,
      answerLane,
      requestPr,
      status,
      laneOf: (workspaceId) => {
        const lane = laneByWorkspace(workspaceId);
        return lane ? { runId: lane.run_id, laneId: lane.id } : undefined;
      },
      runOf: (workspaceId) => {
        const run = runByWorkspace(workspaceId);
        return run ? viewOf(run) : undefined;
      },
      setPrOpener: (open) => {
        if (openPr) throw new Error("The runs module already has a PR opener");
        openPr = open;
      },
    };
    host.provide(RunsKey, api);
    pipelines.setLaneLookup((workspaceId) => {
      const lane = laneByWorkspace(workspaceId);
      return lane
        ? {
            run: workspaces.get(requireRun(lane.run_id).workspace_id).name,
            laneId: lane.id,
            lane: lane.name,
            coordinatorAgentId: coordinatorOf(lane.run_id),
          }
        : undefined;
    });

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

    host.routes.post("/:id/cancel", async (c) =>
      c.json({ run: await cancelRun(c.req.param("id")) }),
    );

    host.routes.get("/:id", (c) => c.json({ run: viewOf(requireRun(c.req.param("id"))) }));
  },
};
