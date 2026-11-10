import { join } from "node:path";
import { ActionsKey } from "@pi-spore/mod-actions/server";
import { AgentsKey } from "@pi-spore/mod-agents/server";
import { ArtifactsKey } from "@pi-spore/mod-artifacts/server";
import { ApprovalsKey } from "@pi-spore/mod-attention/server";
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
  loadSettings,
  type PlanSnapshot,
  planState,
  type RouterSettings,
  readPlans,
  readRecords,
  splitModel,
  TIERS,
  tierOf,
} from "@pi-spore/router";
import {
  GATE_LOG_HEADING,
  logTail,
  type PipelineEvent,
  type PipelineRun,
  type PipelineRunState,
  type PipelineSource,
  type PipelineStage,
  type PipelineTurn,
  type PipelineTurnKind,
  parseJsonBody,
  type StageReport,
  type StageRole,
  StartPipelineRequest,
  stripAnsi,
  type TestProof,
} from "@pi-spore/shared";
import Type, { type Static } from "typebox";
import { type Pipelines, PipelinesKey, type StartRunRequest } from "./contract.js";
import { NO_DIFF, renderDiff } from "./diff.js";
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
  // The round-limit approval a run waits on (slice 5).
  "ALTER TABLE pipelines_runs ADD COLUMN approval_id TEXT",
  // The local-implementer approval a run waits on, and the worker model that answer chose (R4.10). Not `approval_id`:
  // the decide step reads that one for the round limit.
  "ALTER TABLE pipelines_runs ADD COLUMN local_approval_id TEXT",
  "ALTER TABLE pipelines_runs ADD COLUMN worker_model TEXT",
  // The router's newest decision for a worker turn's agent, as JSON (R4.7). Null for a stage on a fixed model.
  "ALTER TABLE pipelines_turns ADD COLUMN routing TEXT",
  // Why the turn's agent failed, set by Retry when it starts a fresh agent for the turn.
  "ALTER TABLE pipelines_turns ADD COLUMN error TEXT",
  // Why a review turn's agent runs on another model than the role default: the default's plan was full (R4.10).
  "ALTER TABLE pipelines_turns ADD COLUMN model_note TEXT",
  // A fix pass: the run whose worker it reuses, and the workspace head when it started, the base of its fix diff.
  "ALTER TABLE pipelines_runs ADD COLUMN previous_run_id TEXT",
  "ALTER TABLE pipelines_runs ADD COLUMN fix_base TEXT",
  // The last blocked error told to the run's chat. A new error sends one message; the same error never sends twice.
  "ALTER TABLE pipelines_runs ADD COLUMN blocked_sent TEXT",
  // The slice's name, a label only: lets the user tell which run built which slice.
  "ALTER TABLE pipelines_runs ADD COLUMN name TEXT",
];

/** The approval kind filed when a review stage uses its last round on a REVISE (R6.4). */
const ROUND_LIMIT = "pipeline-round-limit";
const RoundLimitSubject = Type.Object(
  {
    runId: Type.String(),
    stage: Type.String(),
    action: Type.Union([Type.Literal("fix"), Type.Literal("accept")]),
  },
  { additionalProperties: false },
);
type RoundLimitSubject = Static<typeof RoundLimitSubject>;

/** The approval kind filed when a pinned cloud worker model is under plan pressure (R4.10). */
const LOCAL_IMPLEMENTER = "pipeline-local-implementer";
const LocalImplementerSubject = Type.Object(
  { runId: Type.String() },
  { additionalProperties: false },
);
type LocalImplementerSubject = Static<typeof LocalImplementerSubject>;

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
  approval_id: string | null;
  local_approval_id: string | null;
  worker_model: string | null;
  previous_run_id: string | null;
  fix_base: string | null;
  blocked_sent: string | null;
  name: string | null;
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
  routing: string | null;
  error: string | null;
  model_note: string | null;
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

/**
 * `boot` is the server start that last waited for the stage's report; a different one means a restart (R6.6).
 * `gate` and `attempt` are a gate stage's place: the gate to run, and how often a restart cut it off.
 */
interface StageCheckpoint {
  boot?: string;
  /** The turn that got the "ended without a report" reminder, so it is sent once per turn, also across a restart. */
  reminded?: string;
  gate?: number;
  attempt?: number;
}

/** How much of a failed gate's log goes into the run's message. */
const LOG_TAIL_CHARS = 4096;
const MAX_FAILED_TESTS_LISTED = 10;

/** The message of a run that a gate ended: no color codes, the failed vitest tests, then the log tail. */
function gateFailureMessage(name: string, error: string | undefined, log: string): string {
  const failed = [
    ...new Set(
      [...stripAnsi(log).matchAll(/^ FAIL +(.+)$/gm)].map((found) => (found[1] as string).trim()),
    ),
  ];
  const tests = failed.length
    ? [
        `${failed.length === 1 ? "1 test" : `${failed.length} tests`} failed:`,
        ...failed.slice(0, MAX_FAILED_TESTS_LISTED),
      ]
    : [];
  const tail = logTail(log, LOG_TAIL_CHARS);
  return [
    `gate ${name} failed`,
    ...(error ? [stripAnsi(error)] : []),
    ...tests,
    ...(tail ? ["", GATE_LOG_HEADING, tail] : []),
  ].join("\n");
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
  ...(row.routing
    ? { routing: JSON.parse(row.routing) as NonNullable<PipelineTurn["routing"]> }
    : {}),
  createdAt: row.created_at,
  ...(row.reported_at === null ? {} : { reportedAt: row.reported_at }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.model_note === null ? {} : { modelNote: row.model_note }),
});

const runToView = (row: RunRow, turns: readonly TurnRow[], blocked?: string): PipelineRun => ({
  id: row.id,
  workspaceId: row.workspace_id,
  pipelineId: row.pipeline_id,
  ...(row.name === null ? {} : { name: row.name }),
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
  ...(blocked === undefined ? {} : { blocked }),
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

const taskPrompt = (
  stage: PipelineStage,
  pipeline: string,
  turnId: string,
  briefPath: string,
  brief: string,
) =>
  [
    stage.worker === "reuse"
      ? `Your change came back with a new brief. You are the "${stage.name}" stage of pipeline "${pipeline}". Do what the brief asks.`
      : `You are the "${stage.name}" stage of pipeline "${pipeline}". Implement the brief.`,
    "",
    `Turn: ${turnId}`,
    "",
    `The brief is the workspace artifact ${briefPath}. Its text is below.`,
    "Write each new test first and keep the output of its failing run as a workspace artifact: that is its proof.",
    `When you are done, call report with turn ${turnId}, a short summary, and tests: one entry for each test you added, with its name and the artifact path of its proof.`,
    "Your turn ends only with that report.",
    "",
    "## Brief",
    "",
    brief,
  ].join("\n");

const bullets = (tests: readonly TestProof[]) =>
  tests.length === 0
    ? ["(the worker listed no tests)"]
    : tests.map((test) => `- ${test.name}: proof ${test.proof}`);

const REVISE_ONLY = [
  "Answer revise only for a finding that is a bug, a missing or wrong test, a regression, or a break of the brief.",
  "List anything else (style, naming, wording, taste) as minor.",
];

/** A fix pass: the fix diff, and the last review of the run it continues (none when that run had no review). */
interface FixPass {
  diff: string;
  review: StageReport | undefined;
}

const reviewPrompt = (
  stage: PipelineStage,
  round: number,
  turnId: string,
  paths: { brief: string; diff: string },
  tests: readonly TestProof[],
  earlier?: { review: StageReport; fix: StageReport },
  fixPass?: FixPass,
) =>
  [
    stage.role === "adversarial-reviewer"
      ? `You are the "${stage.name}" stage, round ${round} of ${stage.rounds ?? 1}. Try to break the worker's change: hunt for wrong assumptions, edge cases, and failure paths the brief implies.`
      : `You are the "${stage.name}" stage, round ${round} of ${stage.rounds ?? 1}. Review the worker's change against the brief.`,
    "You are read-only. Do not edit files.",
    "",
    `Turn: ${turnId}`,
    "",
    `The brief is the workspace artifact ${paths.brief}.`,
    `The diff is the workspace artifact ${paths.diff}: the commits since the base, then the uncommitted and untracked files. A note marks any file whose diff is cut short; read that file.`,
    "The worker listed these new tests, each with the artifact that proves it failed before the code:",
    ...bullets(tests),
    "Open each proof and check that it shows the test failing for the right reason. Check that every test the change adds is in this list; a test that is not listed is a finding.",
    ...(earlier
      ? [
          `Round ${round - 1} reviewer summary: ${earlier.review.summary}`,
          `Round ${round - 1} findings:`,
          ...(findingLines(earlier.review).length > 0
            ? findingLines(earlier.review)
            : ["(none listed)"]),
          `The worker's fix report: ${earlier.fix.summary}`,
          "First check that each earlier finding is fixed.",
          ...REVISE_ONLY,
          `A new finding that round ${round - 1} could have raised is important at most, not blocking.`,
        ]
      : []),
    ...(fixPass
      ? [
          "This run is a fix pass of a change a pipeline already checked.",
          `The fix diff is the workspace artifact ${fixPass.diff}: the commits since the fix started, then the uncommitted and untracked files.`,
          ...(fixPass.review
            ? [
                `Earlier reviewer summary: ${fixPass.review.summary}`,
                "Earlier findings:",
                ...(findingLines(fixPass.review).length > 0
                  ? findingLines(fixPass.review)
                  : ["(none listed)"]),
              ]
            : ["(no earlier review)"]),
          "Check that the brief's asks are met and that nothing broke.",
          ...REVISE_ONLY,
        ]
      : []),
    `When you are done, call report with turn ${turnId}, a short summary, a verdict (approve or revise), and findings, each with a severity (blocking, important, or minor). Do not send tests.`,
    "Your turn ends only with that report.",
  ].join("\n");

const findingLines = (report: StageReport) =>
  (report.findings ?? []).flatMap((finding, index) => {
    const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
    return [
      `${index + 1}. [${finding.severity}] ${finding.title}${where}`,
      ...(finding.detail ? [`   ${finding.detail.split("\n").join("\n   ")}`] : []),
    ];
  });

const fixPrompt = (stage: PipelineStage, review: StageReport, turnId: string, last: boolean) =>
  [
    `The reviewer of stage "${stage.name}" asked for changes.`,
    "",
    `Turn: ${turnId}`,
    "",
    `Reviewer summary: ${review.summary}`,
    "Findings:",
    ...(findingLines(review).length > 0 ? findingLines(review) : ["(none listed)"]),
    "",
    "Fix what the findings ask for. Write each new test first and keep its failing run as a workspace artifact, as before.",
    last
      ? "This is the last fix: no review follows it."
      : "A fresh reviewer checks the result next.",
    `When you are done, call report with turn ${turnId}, a short summary, and tests: one entry for each test you added in this turn.`,
    "Your turn ends only with that report.",
  ].join("\n");

const restartMessage = (turnId: string) =>
  `pi-spore restarted while you worked. Continue, then call report with this turn.\n\nTurn: ${turnId}`;

const endedMessage = (turnId: string) =>
  `You ended your turn without calling report. Finish the work, then call report with this turn.\n\nTurn: ${turnId}`;

export const pipelinesModule: ServerModule = {
  id: "pipelines",
  requires: ["projects", "workspaces", "agents", "artifacts", "attention", "actions"],
  core: false,
  setup(host) {
    host.store.migrate("pipelines", MIGRATIONS);
    const projects = host.use(ProjectsKey);
    const workspaces = host.use(WorkspacesKey);
    const agents = host.use(AgentsKey);
    const artifacts = host.use(ArtifactsKey);
    const approvals = host.use(ApprovalsKey);
    const actions = host.use(ActionsKey);
    const userDir = join(host.home.root, "pipelines");
    const bootId = host.newId();
    let laneLookup: Parameters<Pipelines["setLaneLookup"]>[0] | undefined;

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
    // A stage job that failed a step waits with its error; a running run shows it, so the user can fix and retry.
    const blockedOf = (row: RunRow): string | undefined =>
      row.state !== "running"
        ? undefined
        : (host.jobs
            .list({ kind: STAGE_JOB, key: row.workspace_id, states: NOT_ENDED })
            .find((job) => (job.subject as StageSubject).runId === row.id && job.error !== null)
            ?.error ?? undefined);
    const viewOf = (row: RunRow) => runToView(row, turnRows(row.id), blockedOf(row));
    const runsOf = (workspaceId: string): PipelineRun[] =>
      host.store
        .all<RunRow>(
          "SELECT * FROM pipelines_runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC",
          workspaceId,
        )
        .map(viewOf);

    // Chats that carry a "working" label for a running run. The label is in memory only, so boot sets it again.
    const labelled = new Set<string>();
    agents.beforeDeleteChat((agentId) => labelled.delete(agentId));
    // Retention can delete a chat, or the run workspace of a lane, while a run still runs. One missing id must not
    // stop the sync of the others; any other error still throws.
    const unlessGone = <T>(read: () => T): T | undefined => {
      try {
        return read();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
    };
    /**
     * Marks the chat of each running run as working, so Home does not show it as done while its run works. A
     * waiting_user run gives no label (its approval is the Home item), and neither does an ended one (the chat
     * has the end message). A lane's run belongs to the run's coordinator, as in `tellBlocked`.
     */
    const syncWorking = () => {
      const byAgent = new Map<string, RunRow[]>();
      for (const run of host.store.all<RunRow>(
        "SELECT * FROM pipelines_runs WHERE state = 'running' ORDER BY created_at, id",
      )) {
        const agentId = unlessGone(
          () => laneLookup?.(run.workspace_id)?.coordinatorAgentId ?? run.asking_agent_id,
        );
        if (agentId !== undefined && unlessGone(() => !agents.isClosed(agentId))) {
          byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), run]);
        }
      }
      for (const [agentId, runs] of byAgent) {
        const [run] = runs as [RunRow];
        let label = `Pipeline: ${runs.length} runs`;
        if (runs.length === 1) {
          const stage = stageOf(run, run.stage_index);
          const round = stageTurns(run, run.stage_index).filter(
            (turn) => turn.kind === "review",
          ).length;
          label = `Pipeline: ${stage.name}${round >= 2 ? `, round ${round}` : ""}`;
        }
        agents.setWorkingFor(agentId, label);
        labelled.add(agentId);
      }
      for (const agentId of labelled) {
        if (byAgent.has(agentId)) continue;
        labelled.delete(agentId);
        unlessGone(() => agents.setWorkingFor(agentId, undefined));
      }
    };

    const changeListeners: ((workspaceId: string) => void)[] = [];
    const publish = (workspaceId: string) => {
      const event: PipelineEvent = { type: "runs", runs: runsOf(workspaceId) };
      host.events.publish(`${PIPELINES_TOPIC}${workspaceId}`, event);
      for (const listener of changeListeners) listener(workspaceId);
      syncWorking();
    };
    host.onStarted(syncWorking);
    host.events.onSubscribe(PIPELINES_TOPIC, (topic) => {
      const workspace = workspaces.get(topic.slice(PIPELINES_TOPIC.length));
      const event: PipelineEvent = { type: "runs", runs: runsOf(workspace.id) };
      return [event];
    });
    // The job moves a run on; the browser sees it here.
    host.jobs.onChange((job) => {
      if (job.kind !== STAGE_JOB || job.key === null) return;
      publish(job.key);
      tellBlocked((job.subject as StageSubject).runId);
    });
    // A failed or refused turn never reports, so the agent's status change wakes `await` to see it.
    agents.onChange((agentId, change) => {
      if (change !== "status" || agents.get(agentId).kind !== "stage") return;
      const open = host.store.get<{ workspace_id: string }>(
        `SELECT r.workspace_id FROM pipelines_turns t JOIN pipelines_runs r ON r.id = t.run_id
         WHERE t.agent_id = ? AND t.report IS NULL AND t.error IS NULL AND r.state = 'running'`,
        agentId,
      );
      if (open) host.jobs.wake(STAGE_JOB, open.workspace_id);
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

    const endListeners: ((run: PipelineRun) => void)[] = [];
    // Every caller is inside a transaction (a job commit, `decided`, or cancel), so a listener's throw undoes the end.
    const endRun = (runId: string, state: "passed" | "failed" | "stopped", message?: string) => {
      host.store.run(
        "UPDATE pipelines_runs SET state = ?, message = ?, ended_at = ? WHERE id = ?",
        state,
        message ?? null,
        host.now(),
        runId,
      );
      const row = requireRun(runId);
      const ended = viewOf(row);
      for (const listener of endListeners) listener(ended);
      if (!laneLookup?.(ended.workspaceId)) agents.deliver(row.asking_agent_id, endMessage(ended));
    };

    /** The run this step belongs to, or undefined when the run was stopped or has moved on: the job just ends. */
    const runOf = (subject: StageSubject): RunRow | undefined => {
      const run = loadRun(subject.runId);
      return run?.state === "running" && run.stage_index === subject.stageIndex ? run : undefined;
    };

    /** How an approval names the run's workspace: a lane also names its lane and run. */
    const workspaceLabel = (workspaceId: string) => {
      const name = `workspace "${workspaces.get(workspaceId).name}"`;
      const lane = laneLookup?.(workspaceId);
      return lane ? `${name}, lane "${lane.lane}" (${lane.laneId}) of run "${lane.run}"` : name;
    };

    /** What the asking chat reads when its run ends: the state, the stop or failure text, and the last review. */
    const endMessage = (ended: PipelineRun): string => {
      const lines = [
        `Pipeline run ${ended.id} on ${workspaceLabel(ended.workspaceId)} ended ${ended.state}.`,
      ];
      if (ended.message) lines.push(ended.message);
      const report = ended.turns.findLast(
        (turn) => turn.kind === "review" && turn.report?.verdict,
      )?.report;
      if (report) {
        lines.push(`Last review: ${report.verdict}`);
        for (const finding of report.findings ?? []) {
          const where = finding.file
            ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
            : "";
          lines.push(`- ${finding.severity}: ${finding.title}${where}`);
        }
      }
      if (ended.state === "passed") lines.push("Read the diff before the next slice.");
      return lines.join("\n");
    };

    /**
     * Tells the run's chat about a new blocked error, once. The column is the dedupe: a retry that fails the same way
     * sends nothing. A lane's message goes to its run's current coordinator.
     */
    const tellBlocked = (runId: string) =>
      host.store.transaction(() => {
        const current = loadRun(runId);
        if (!current) return;
        const error = blockedOf(current);
        if (error === undefined || error === current.blocked_sent) return;
        const stage = stageOf(current, current.stage_index);
        host.store.run("UPDATE pipelines_runs SET blocked_sent = ? WHERE id = ?", error, runId);
        agents.deliver(
          laneLookup?.(current.workspace_id)?.coordinatorAgentId ?? current.asking_agent_id,
          [
            `Pipeline run ${runId} on ${workspaceLabel(current.workspace_id)} is blocked at stage "${stage.name}": ${error}`,
            `Fix the cause, then Retry the run on its Pipeline tab (POST /api/pipelines/runs/${runId}/retry). Retry runs the step again.`,
          ].join("\n"),
        );
      });

    const stageOf = (run: RunRow, stageIndex: number) =>
      (JSON.parse(run.stages) as PipelineStage[])[stageIndex] as PipelineStage;
    // A failed turn was replaced by a fresh agent's turn, so rounds and earlier reports count only the others.
    const stageTurns = (run: RunRow, stageIndex: number) =>
      turnRows(run.id).filter((turn) => turn.stage_index === stageIndex && turn.error === null);
    const modelOf = (stage: PipelineStage) =>
      stage.model ?? (stage.tier === "route" ? ROUTE_MODEL : undefined);
    const rolesTitle = (role: StageRole) => (role === "reviewer" ? "Review" : "Adversarial");

    /** The plan a model draws on (`router.plans`) and its usage now. A provider with no plan has none. */
    const planOf = (
      settings: RouterSettings,
      snapshots: readonly PlanSnapshot[],
      model: string,
    ): { plan: string; state: ReturnType<typeof planState> } | undefined => {
      const plan = settings.plans[splitModel(model).provider];
      if (!plan) return undefined;
      const snapshot = snapshots.find((entry) => entry.plan === plan);
      return {
        plan,
        state: planState(plan, snapshot, host.now(), {
          maxAgeMs: settings.usageMaxAgeMinutes * 60_000,
          weekly: settings.pressure.weekly,
          fiveHour: settings.pressure.fiveHour,
        }),
      };
    };

    /**
     * The model a reviewer stage will run on: the stage's, else the role default, else none (the agent's own
     * default). A role default whose plan is full gives way to the first ladder model of its tier or higher whose
     * plan is not full (R4.10, ADR 0141); `note` says so. A started agent keeps its model (ADR 0140).
     */
    const reviewerModel = async (
      stage: PipelineStage,
      settings: RouterSettings,
    ): Promise<{ model?: string; note?: string }> => {
      const pinned = modelOf(stage);
      if (pinned) return { model: pinned };
      const role = stage.role as StageRole;
      const defaults = await agents.roleDefaults(role);
      if (!defaults.provider || !defaults.modelId) return {};
      const model = `${defaults.provider}/${defaults.modelId}`;
      const snapshots = (await readPlans(host.home.root)).plans;
      const own = planOf(settings, snapshots, model);
      // No fresh numbers count as room, as in the router.
      if (own?.state.room !== "full") return { model };
      const tier = tierOf(settings, model);
      // Settings allow a ladder model with no tier. It cannot be shown strong enough, so it ranks below every tier.
      const rank = (candidate: string) => {
        const candidateTier = settings.tiers[candidate];
        return candidateTier ? TIERS.indexOf(candidateTier) : -1;
      };
      const chosen = [
        ...new Set(settings.ladders.flatMap((ladder) => ladder.rungs.map((rung) => rung.model))),
      ]
        .filter((candidate) => candidate !== model && rank(candidate) >= TIERS.indexOf(tier))
        .sort((a, b) => rank(a) - rank(b))
        .find((candidate) => planOf(settings, snapshots, candidate)?.state.room !== "full");
      const until =
        own.state.resetsAt === undefined
          ? ""
          : ` until ${new Date(own.state.resetsAt).toISOString()}`;
      if (!chosen) {
        throw new Error(
          `stage ${stage.name}: the ${role} default ${model} is on plan ${own.plan}, which is full${until}; no ladder model of tier ${tier} or higher has room. Retry after the reset, or set another ${role} model in the pi-subagents settings.`,
        );
      }
      return { model: chosen, note: `${model}: plan ${own.plan} is full${until}; took ${chosen}` };
    };

    /**
     * The models every worker of the run ran on, failed ones too: a failed worker may have written code (R4.4). A
     * worker that reported has a session, so none recorded is an error.
     */
    const workerModels = async (run: RunRow): Promise<string[]> => {
      const workers = [
        ...new Set(
          turnRows(run.id)
            .filter((turn) => turn.role === "worker")
            .map((turn) => turn.agent_id),
        ),
      ];
      const used = new Set<string>();
      for (const worker of workers)
        for (const model of await agents.modelsUsed(worker)) used.add(model);
      if (used.size === 0) {
        throw new Error(`Pi recorded no model for the worker agent ${run.worker_agent_id}`);
      }
      return [...used];
    };

    /**
     * R4.4 with the tier list (ADR 0023, 0152): the first reviewer model that may not review a worker model, as a
     * sentence. A worker of the `local` tier needs a reviewer of a strictly higher tier; any other worker accepts a
     * reviewer of its own tier, the same model included.
     */
    const notStronger = (
      settings: RouterSettings,
      reviewers: readonly string[],
      workers: readonly string[],
    ): string | undefined => {
      for (const reviewer of reviewers) {
        const reviewerTier = tierOf(settings, reviewer);
        for (const worker of workers) {
          const workerTier = tierOf(settings, worker);
          const gap = TIERS.indexOf(reviewerTier) - TIERS.indexOf(workerTier);
          if (gap < (workerTier === "local" ? 1 : 0)) {
            return `${reviewer} (tier ${reviewerTier}) is not above ${worker} (tier ${workerTier})`;
          }
        }
      }
      return undefined;
    };

    /**
     * R4.10: the worker model and its plan notes when the stage pins a cloud model whose plan is under pressure.
     * A model with no tier is not asked about: the stage goes on as before.
     */
    const pressuredPin = async (
      stage: PipelineStage,
    ): Promise<{ model: string; notes: string[] } | undefined> => {
      let model = modelOf(stage);
      if (!model) {
        const defaults = await agents.roleDefaults("worker");
        if (defaults.provider && defaults.modelId)
          model = `${defaults.provider}/${defaults.modelId}`;
      }
      if (!model || model === ROUTE_MODEL) return undefined;
      const settings = await loadSettings(host.home.root);
      try {
        if (tierOf(settings, model) === "local") return undefined;
      } catch {
        return undefined;
      }
      const used = planOf(settings, (await readPlans(host.home.root)).plans, model);
      return used?.state.pressure ? { model, notes: used.state.notes } : undefined;
    };

    const advanceWorker = async (
      run: RunRow,
      stage: PipelineStage,
      stageIndex: number,
    ): Promise<StepOutcome<StageCheckpoint>> => {
      const briefPath = `pipelines/${run.id}/brief.md`;
      await artifacts.write({ scope: "workspace", id: run.workspace_id }, briefPath, run.brief);
      const giveTask = (agentId: string) => {
        const turnId = insertTurn(run, stageIndex, stage, 1, "task", "worker", agentId);
        host.store.run(
          "UPDATE pipelines_runs SET worker_agent_id = ? WHERE id = ?",
          agentId,
          run.id,
        );
        agents.deliver(agentId, taskPrompt(stage, run.pipeline_id, turnId, briefPath, run.brief));
      };
      // The reused worker keeps its model, so there is no pin to question.
      if (stage.worker === "reuse") {
        const worker = requireRun(run.previous_run_id as string).worker_agent_id as string;
        return { checkpoint: { boot: bootId }, commit: () => giveTask(worker) };
      }
      const pinned = run.worker_model === null ? await pressuredPin(stage) : undefined;
      if (pinned) {
        return {
          wait: true,
          commit: () => {
            const message = `Stage ${stage.name} waits on your answer: switch to the local implementer?`;
            const approval = approvals.file(
              { agentId: run.asking_agent_id, workspaceId: run.workspace_id },
              {
                kind: LOCAL_IMPLEMENTER,
                title: `Switch stage "${stage.name}" to the local implementer?`,
                reason: `The worker model ${pinned.model} is pinned, and its plan is under usage pressure (${pinned.notes.join("; ")}). Approve runs this run's stage on ${ROUTE_MODEL}: the router sends it local only when the task is bounded, and visual work stays on the cloud. Decline keeps ${pinned.model}. Settings do not change.`,
                subject: { runId: run.id },
              },
            );
            host.store.run(
              "UPDATE pipelines_runs SET state = 'waiting_user', local_approval_id = ?, worker_model = ?, message = ? WHERE id = ?",
              approval.id,
              pinned.model,
              message,
              run.id,
            );
          },
        };
      }
      const model = run.worker_model ?? modelOf(stage);
      return {
        checkpoint: { boot: bootId },
        commit: () => {
          const agent = agents.createStage(run.workspace_id, {
            role: "worker",
            title: stage.name,
            ...(model ? { model } : {}),
          });
          giveTask(agent.id);
        },
      };
    };

    const insertTurn = (
      run: RunRow,
      stageIndex: number,
      stage: PipelineStage,
      round: number,
      kind: PipelineTurnKind,
      role: StageRole,
      agentId: string,
      modelNote?: string,
    ): string => {
      const turnId = host.newId();
      host.store.run(
        `INSERT INTO pipelines_turns (id, run_id, stage_index, stage, round, kind, role, agent_id, model_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        turnId,
        run.id,
        stageIndex,
        stage.name,
        round,
        kind,
        role,
        agentId,
        modelNote ?? null,
        host.now(),
      );
      return turnId;
    };

    /** Starts the worker's fix turn for a review. `last` tells the worker no review follows. */
    const startFix = (
      run: RunRow,
      stageIndex: number,
      stage: PipelineStage,
      review: TurnRow,
      last: boolean,
    ) => {
      const worker = run.worker_agent_id as string;
      const turnId = insertTurn(run, stageIndex, stage, review.round, "fix", "worker", worker);
      agents.deliver(worker, fixPrompt(stage, reportOf(review), turnId, last));
    };

    /** The workspace's change operations (none when its project has no version control that shows them). */
    const changesOf = async (workspaceId: string) => {
      const workspace = workspaces.get(workspaceId);
      const project = await projects.get(workspace.projectId);
      return {
        workspace,
        project,
        ops: projects.vcsFor(project).changes,
        location: { path: workspace.path, ...(workspace.line ? { line: workspace.line } : {}) },
      };
    };

    /**
     * The diff artifact: commits since the workspace's base, plus uncommitted and untracked files. A fix diff passes the
     * run's `fix_base` instead; null (no head when the fix started) lists no commits.
     */
    const writeDiff = async (run: RunRow, path: string, fixBase?: string | null) => {
      const { workspace, project, ops, location } = await changesOf(run.workspace_id);
      const base =
        fixBase === undefined
          ? (workspace.base ?? (await ops?.defaultBase(project)))
          : (fixBase ?? undefined);
      const text = ops ? await renderDiff(ops, location, base) : NO_DIFF;
      await artifacts.write({ scope: "workspace", id: run.workspace_id }, path, text);
    };

    const advanceReviewer = async (
      run: RunRow,
      stage: PipelineStage,
      stageIndex: number,
    ): Promise<StepOutcome<StageCheckpoint>> => {
      const role = stage.role as StageRole;
      const settings = await loadSettings(host.home.root);
      const { model, note } = await reviewerModel(stage, settings);
      if (stage.min_strength_over) {
        // Checked before the reviewer exists, so a refused model creates no agent. A throw waits for a settings fix.
        if (!model) {
          throw new Error(
            `stage ${stage.name}: min_strength_over needs the ${role} model, but the stage sets no model and the ${role} role has no default; set "model" in the stage or the ${role} model in the pi-subagents settings`,
          );
        }
        const problem = notStronger(settings, [model], await workerModels(run));
        if (problem) {
          throw new Error(
            `stage ${stage.name} (min_strength_over ${stage.min_strength_over}): reviewer model ${problem}; set a reviewer model of a high enough tier in the stage or fix "tiers" in settings.json, then retry`,
          );
        }
      }
      const turns = stageTurns(run, stageIndex);
      const round = turns.filter((turn) => turn.kind === "review").length + 1;
      // Round 2 and later: the last two turns are the previous review and the worker's fix for it.
      const earlier =
        round > 1
          ? { review: reportOf(turns.at(-2) as TurnRow), fix: reportOf(turns.at(-1) as TurnRow) }
          : undefined;
      const paths = {
        brief: `pipelines/${run.id}/brief.md`,
        diff: `pipelines/${run.id}/${stage.name}-${round}.diff`,
      };
      await writeDiff(run, paths.diff);
      const fixPass: FixPass | undefined =
        run.previous_run_id === null
          ? undefined
          : {
              diff: `pipelines/${run.id}/${stage.name}-${round}-fix.diff`,
              review: turnRows(run.previous_run_id)
                .filter((turn) => turn.kind === "review" && turn.report !== null)
                .map(reportOf)
                .at(-1),
            };
      if (fixPass) await writeDiff(run, fixPass.diff, run.fix_base);
      const tests = JSON.parse(run.tests) as TestProof[];
      return {
        checkpoint: { boot: bootId },
        commit: () => {
          const agent = agents.createStage(run.workspace_id, {
            role,
            title: `${rolesTitle(role)} ${round}`,
            ...(model ? { model } : {}),
          });
          const turnId = insertTurn(run, stageIndex, stage, round, "review", role, agent.id, note);
          agents.deliver(
            agent.id,
            reviewPrompt(stage, round, turnId, paths, tests, earlier, fixPass),
          );
        },
      };
    };

    const advance = async ({
      subject,
    }: {
      subject: StageSubject;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      // Retry or a restart runs this step again while the user answers the local-implementer question.
      const waiting = loadRun(subject.runId);
      if (waiting?.state === "waiting_user" && waiting.stage_index === subject.stageIndex) {
        return { wait: true };
      }
      const run = runOf(subject);
      if (!run) return { next: null };
      const stage = stageOf(run, subject.stageIndex);
      if (stage.role === "worker") return advanceWorker(run, stage, subject.stageIndex);
      if (stage.role) return advanceReviewer(run, stage, subject.stageIndex);
      return advanceGates(run, stage);
    };

    /** ADR 0016: the proofs are checked once, before any gate action starts. The gate steps then run the actions. */
    const advanceGates = async (
      run: RunRow,
      stage: PipelineStage,
    ): Promise<StepOutcome<StageCheckpoint>> => {
      if (stage.fail_first === "artifact") {
        for (const test of JSON.parse(run.tests) as TestProof[]) {
          if (!(await hasProof(run, test))) {
            return {
              next: null,
              commit: () =>
                endRun(
                  run.id,
                  "failed",
                  `missing fail-first proof for ${test.name} (${test.proof})`,
                ),
            };
          }
        }
      }
      return { next: "gate" };
    };

    /** A proof is a non-empty workspace artifact. A path the artifacts module refuses is as missing as an absent file. */
    const hasProof = async (run: RunRow, test: TestProof): Promise<boolean> => {
      try {
        const { bytes } = await artifacts.read(
          { scope: "workspace", id: run.workspace_id },
          test.proof,
        );
        return bytes.length > 0;
      } catch (error) {
        if (error instanceof ApiError && ["file_not_found", "bad_path"].includes(error.code)) {
          return false;
        }
        throw error;
      }
    };

    /**
     * Runs the gate at the checkpoint's place. The key is built from the run, stage, gate, and attempt, so a step that
     * runs again after a restart gets the same action run back instead of starting another. An unknown action throws:
     * the job waits with the error until the user fixes config.toml and retries.
     */
    const runGate = async ({
      subject,
      checkpoint,
    }: {
      subject: StageSubject;
      checkpoint: StageCheckpoint | undefined;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      const run = runOf(subject);
      if (!run) return { next: null };
      const stage = stageOf(run, subject.stageIndex);
      const gates = stage.gates as string[];
      const gate = checkpoint?.gate ?? 0;
      const attempt = checkpoint?.attempt ?? 0;
      const name = gates[gate] as string;
      const started = await actions
        .start(run.workspace_id, name, "pipeline", {
          key: `${run.id}:${stage.name}:${name}:${attempt}`,
        })
        .catch(async (error: unknown) => {
          if (!(error instanceof ApiError) || error.code !== "action_not_found") throw error;
          const project = await projects.get(workspaces.get(run.workspace_id).projectId);
          throw new Error(
            `stage "${stage.name}": no action "${name}" in ${join(project.path, ".pi-spore", "config.toml")}. Add it there, then Retry.`,
          );
        });
      const ended = await actions.wait(started.id);
      if (ended.status === "interrupted")
        return { next: "gate", checkpoint: { gate, attempt: attempt + 1 } };
      if (ended.status === "succeeded") {
        return gate + 1 < gates.length
          ? { next: "gate", checkpoint: { gate: gate + 1, attempt: 0 } }
          : { next: "finish" };
      }
      const { text } = await actions.readLog(ended.id, undefined);
      const message = gateFailureMessage(name, ended.error, text);
      return { next: null, commit: () => endRun(run.id, "failed", message) };
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
      if (turn.error !== null) return replaceFailed(run, subject.stageIndex, turn);
      const failure = await agents.turnError(turn.agent_id);
      if (failure !== undefined) {
        throw new Error(
          `stage ${turn.stage}: the ${turn.role} agent "${agents.get(turn.agent_id).title}" failed: ${failure}. Retry starts a fresh ${turn.role} agent for this turn.`,
        );
      }
      if (checkpoint?.boot !== bootId) {
        // The server restarted while the agent worked. Its process is gone, so it gets one reminder (R6.6).
        return {
          wait: true,
          checkpoint: { ...checkpoint, boot: bootId },
          commit: () => agents.deliver(turn.agent_id, restartMessage(turn.id)),
        };
      }
      if (!(await agents.endedRun(turn.agent_id))) return { wait: true };
      // The agent may have done the whole turn and reported while the awaits above read its session file.
      if (latestTurn(run.id)?.report !== null) return {};
      // The agent ended its turn without a report: one reminder, then the stage blocks (ADR 0169).
      if (checkpoint.reminded === turn.id) {
        throw new Error(
          `stage ${turn.stage}: the ${turn.role} agent "${agents.get(turn.agent_id).title}" ended its turn twice without a report. Retry starts a fresh ${turn.role} agent for this turn.`,
        );
      }
      return {
        wait: true,
        checkpoint: { ...checkpoint, reminded: turn.id },
        commit: () => agents.deliver(turn.agent_id, endedMessage(turn.id)),
      };
    };

    /** Retry marked the turn failed: a fresh agent of its role takes it over. The old agent stays, renamed. */
    const replaceFailed = async (
      run: RunRow,
      stageIndex: number,
      turn: TurnRow,
    ): Promise<StepOutcome<StageCheckpoint>> => {
      const rename = () =>
        agents.rename(turn.agent_id, `${agents.get(turn.agent_id).title} (failed)`);
      if (turn.kind !== "fix") return { next: "advance", commit: rename };
      const stage = stageOf(run, stageIndex);
      const model = run.worker_model ?? modelOf(stage);
      const review = stageTurns(run, stageIndex).at(-1) as TurnRow;
      return {
        wait: true,
        checkpoint: { boot: bootId },
        commit: () => {
          rename();
          const worker = agents.createStage(run.workspace_id, {
            role: "worker",
            title: stage.name,
            ...(model ? { model } : {}),
          });
          host.store.run(
            "UPDATE pipelines_runs SET worker_agent_id = ? WHERE id = ?",
            worker.id,
            run.id,
          );
          startFix(
            { ...run, worker_agent_id: worker.id },
            stageIndex,
            stage,
            review,
            lastFix(stage, review),
          );
        },
      };
    };

    const rounds = (stage: PipelineStage) => stage.rounds ?? 1;
    const reportOf = (turn: TurnRow) => JSON.parse(turn.report as string) as StageReport;

    /** Jev's early stop (ADR 0015): only on a REVISE before the last round, with no blocking finding. It never adds a round. */
    const stopsEarly = (stage: PipelineStage, review: TurnRow): boolean => {
      const report = reportOf(review);
      return (
        stage.early_stop === "jev" &&
        review.round < rounds(stage) &&
        report.verdict === "revise" &&
        report.earlyStop?.stop === true &&
        !report.findings?.some((finding) => finding.severity === "blocking")
      );
    };

    /** The fix after a review is the stage's last when the rounds are used up (`fix_passes`) or Jev stopped it early. */
    const lastFix = (stage: PipelineStage, review: TurnRow) =>
      review.round >= rounds(stage) || stopsEarly(stage, review);

    /** R4.4 on the report: the models the reviewer really ran on must be allowed to review the worker's. */
    const reviewerWeakness = async (
      run: RunRow,
      stage: PipelineStage,
      review: TurnRow,
    ): Promise<string | undefined> => {
      if (!stage.min_strength_over) return undefined;
      const used = await agents.modelsUsed(review.agent_id);
      if (used.length === 0) {
        throw new Error(`Pi recorded no model for the reviewer agent ${review.agent_id}`);
      }
      return notStronger(await loadSettings(host.home.root), used, await workerModels(run));
    };

    /** Reads the latest reported turn and picks what comes next. Its state is the stage's turns, not a checkpoint. */
    const decide = async ({
      subject,
    }: {
      subject: StageSubject;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      const run = loadRun(subject.runId);
      if (!run || run.stage_index !== subject.stageIndex) return { next: null };
      // Retry or a restart runs this step again while the user decides; it keeps waiting. A decline ends the run.
      if (run.state === "waiting_user") return { wait: true };
      if (run.state !== "running") return { next: null };
      // The user approved the round limit: the stage ends.
      if (run.approval_id !== null) return { next: "finish" };
      const stage = stageOf(run, subject.stageIndex);
      const turns = stageTurns(run, subject.stageIndex);
      const last = turns.at(-1) as TurnRow;
      // The user chose a last fix at the round limit: its turn is open.
      if (last.report === null) return { next: "await", checkpoint: { boot: bootId } };
      if (last.kind === "task") return { next: "finish" };
      if (last.kind === "fix") {
        const review = turns.at(-2) as TurnRow;
        return { next: lastFix(stage, review) ? "finish" : "advance" };
      }
      const weak = await reviewerWeakness(run, stage, last);
      if (weak) {
        return {
          next: null,
          commit: () =>
            endRun(run.id, "failed", `R4.4: stage ${stage.name}: reviewer model ${weak}`),
        };
      }
      const report = reportOf(last);
      if (report.verdict === "approve") return { next: "finish" };
      if (last.round < rounds(stage) || stage.fix_passes === 1) {
        return {
          next: "await",
          checkpoint: { boot: bootId },
          commit: () => startFix(run, subject.stageIndex, stage, last, lastFix(stage, last)),
        };
      }
      return {
        wait: true,
        commit: () => {
          const message = `Stage ${stage.name} used its ${rounds(stage)} review round(s) and the reviewer still asks for changes`;
          const approval = approvals.file(
            { agentId: run.asking_agent_id, workspaceId: run.workspace_id },
            {
              kind: ROUND_LIMIT,
              title: `Review round limit in ${workspaceLabel(run.workspace_id)}: stage "${stage.name}" of pipeline ${run.pipeline_id}`,
              reason: [
                `${message}.`,
                `Reviewer: ${report.summary}`,
                "Findings:",
                ...(findingLines(report).length > 0 ? findingLines(report) : ["(none listed)"]),
                "",
                "Fix: the worker makes one last fix for these findings, with no review after it, and the run goes on.",
                "Accept: the run goes on without a fix.",
                "Decline: the run stops.",
              ].join("\n"),
              subject: { runId: run.id, stage: stage.name, action: "fix" },
            },
          );
          host.store.run(
            "UPDATE pipelines_runs SET state = 'waiting_user', approval_id = ?, message = ? WHERE id = ?",
            approval.id,
            message,
            run.id,
          );
        },
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
            "UPDATE pipelines_runs SET stage_index = ?, approval_id = NULL WHERE id = ?",
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
      { name: "decide", run: decide },
      { name: "gate", run: runGate },
      { name: "finish", run: finish },
    ];
    host.jobs.define(STAGE_JOB, steps);

    const report = async (
      caller: BridgeCaller,
      request: StageReport,
    ): Promise<{ turn: PipelineTurn }> => {
      // The transaction is synchronous, so the router's records are read before it.
      let routing: string | null = null;
      const open = host.store.get<TurnRow>(
        "SELECT * FROM pipelines_turns WHERE id = ?",
        request.turn,
      );
      if (open?.role === "worker") {
        const { records } = await readRecords(host.home.root, 500);
        const decision = records.find((record) => record.agentId === open.agent_id);
        if (decision) {
          const { route, model, reasons } = decision;
          routing = JSON.stringify({ route, ...(model === undefined ? {} : { model }), reasons });
        }
      }
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
        if (row.role !== "worker" && request.verdict === undefined)
          throw new ApiError(400, "bad_report", "A reviewer report needs a verdict");
        if (row.role !== "worker" && request.tests !== undefined)
          throw new ApiError(400, "bad_report", "A reviewer report has no tests");
        const reportedAt = host.now();
        host.store.run(
          "UPDATE pipelines_turns SET report = ?, reported_at = ?, routing = ? WHERE id = ?",
          JSON.stringify(request),
          reportedAt,
          routing,
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
        return { ...row, report: JSON.stringify(request), routing, reported_at: reportedAt };
      });
      publish(requireRun(turn.run_id).workspace_id);
      return { turn: turnToView(turn) };
    };
    approvals.register({
      kind: ROUND_LIMIT,
      subject: RoundLimitSubject,
      // All effects are in `decided`, in the transaction that stores the decision.
      approve: async (subject) =>
        subject.action === "fix"
          ? `The user chose fix: the worker makes one last fix for stage ${subject.stage}, with no review after it; then the run goes on.`
          : `The user chose accept: the run goes on after stage ${subject.stage} without a fix.`,
      decided: (subject: RoundLimitSubject, approval, approved) => {
        const run = loadRun(subject.runId);
        // A run that was stopped or moved on ignores the decision.
        if (run?.state !== "waiting_user" || run.approval_id !== approval.id) return;
        if (approved && subject.action === "fix") {
          // The fix turn is open when the job wakes; `decide` sends it to `await`, and the fix report ends the stage.
          const stage = stageOf(run, run.stage_index);
          const review = stageTurns(run, run.stage_index).at(-1) as TurnRow;
          startFix(run, run.stage_index, stage, review, true);
          host.store.run(
            "UPDATE pipelines_runs SET state = 'running', message = NULL, approval_id = NULL WHERE id = ?",
            run.id,
          );
        } else if (approved) {
          host.store.run(
            "UPDATE pipelines_runs SET state = 'running', message = NULL WHERE id = ?",
            run.id,
          );
        } else {
          endRun(run.id, "stopped", "Declined at the review round limit");
        }
        host.jobs.wake(STAGE_JOB, run.workspace_id);
      },
    });

    approvals.register({
      kind: LOCAL_IMPLEMENTER,
      subject: LocalImplementerSubject,
      // All effects are in `decided`, in the transaction that stores the decision.
      approve: async () => `The stage runs on ${ROUTE_MODEL} for this run.`,
      decided: (subject: LocalImplementerSubject, approval, approved) => {
        const run = loadRun(subject.runId);
        // A run that was stopped or moved on ignores the decision.
        if (run?.state !== "waiting_user" || run.local_approval_id !== approval.id) return;
        // Filing stored the pinned model as the worker model, so a decline keeps it and the stage never asks again.
        host.store.run(
          "UPDATE pipelines_runs SET state = 'running', message = NULL, worker_model = ? WHERE id = ?",
          approved ? ROUTE_MODEL : run.worker_model,
          run.id,
        );
        host.jobs.wake(STAGE_JOB, run.workspace_id);
      },
    });

    const entriesOf = async (workspaceId: string) => {
      const workspace = workspaces.get(workspaceId);
      const project = await projects.get(workspace.projectId);
      return loadPipelines(userDir, join(project.path, ".pi-spore", "pipelines"));
    };

    const start = async (workspaceId: string, request: StartRunRequest): Promise<PipelineRun> => {
      const workspace = workspaces.get(workspaceId);
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
      let fixBase: string | null = null;
      if (entry.stages[0]?.worker === "reuse") {
        if (request.previousRunId === undefined) {
          throw new ApiError(
            400,
            "bad_request",
            `Pipeline "${entry.id}" reuses the worker of an earlier run; name that run in previousRunId`,
          );
        }
        if (request.workerModel !== undefined) {
          throw new ApiError(
            400,
            "bad_request",
            `Pipeline "${entry.id}" reuses the worker of an earlier run, which keeps its model; workerModel is not allowed`,
          );
        }
        const previous = loadRun(request.previousRunId);
        if (previous?.workspace_id !== workspace.id) {
          throw new ApiError(
            404,
            "run_not_found",
            `No pipeline run ${request.previousRunId} in this workspace`,
          );
        }
        if (previous.worker_agent_id === null) {
          throw new ApiError(
            409,
            "run_has_no_worker",
            `Pipeline run ${previous.id} has no worker agent to reuse`,
          );
        }
        const { ops, location } = await changesOf(workspace.id);
        fixBase = (await ops?.head(location)) ?? null;
      } else if (request.previousRunId !== undefined) {
        throw new ApiError(
          400,
          "bad_request",
          `Pipeline "${entry.id}" makes a new worker; previousRunId is only for a pipeline whose worker stage has worker = "reuse"`,
        );
      }
      const askingAgentId = request.askingAgentId ?? (await agents.activeWorker(workspace.id)).id;
      const runId = host.store.transaction(() => {
        requireNoActiveRun(workspace.id);
        const id = host.newId();
        host.store.run(
          `INSERT INTO pipelines_runs (id, workspace_id, pipeline_id, source, path, hash, stages, brief,
             asking_agent_id, worker_model, previous_run_id, fix_base, name, state, stage_index, tests, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, '[]', ?)`,
          id,
          workspace.id,
          entry.id,
          entry.source,
          entry.path ?? null,
          entry.hash,
          JSON.stringify(entry.stages),
          request.brief,
          askingAgentId,
          request.workerModel ?? null,
          request.previousRunId ?? null,
          fixBase,
          request.name ?? null,
          host.now(),
        );
        host.jobs.start(STAGE_JOB, { runId: id, stageIndex: 0 }, { key: workspace.id });
        return id;
      });
      publish(workspace.id);
      return viewOf(requireRun(runId));
    };

    const stop = (runId: string, message: string) => {
      const run = requireRun(runId);
      host.store.transaction(() => {
        if (run.state !== "running" && run.state !== "waiting_user")
          throw new ApiError(409, "run_ended", `The run is ${run.state}`);
        endRun(run.id, "stopped", message);
        for (const job of host.jobs.list({
          kind: STAGE_JOB,
          key: run.workspace_id,
          states: NOT_ENDED,
        })) {
          if ((job.subject as StageSubject).runId === run.id) host.jobs.cancel(job.id);
        }
      });
      publish(run.workspace_id);
    };

    const api: Pipelines = {
      report,
      start,
      get: (runId) => viewOf(requireRun(runId)),
      stop,
      afterRunEnded: (listener) => {
        endListeners.push(listener);
      },
      onChange: (listener) => {
        changeListeners.push(listener);
      },
      refreshWorking: syncWorking,
      setLaneLookup: (lookup) => {
        if (laneLookup) throw new Error("The pipelines module already has a lane lookup");
        laneLookup = lookup;
      },
    };
    host.provide(PipelinesKey, api);

    host.routes.get("/workspaces/:id", async (c) =>
      c.json({ pipelines: await entriesOf(c.req.param("id")) }),
    );

    host.routes.get("/workspaces/:id/runs", (c) =>
      c.json({ runs: runsOf(workspaces.get(c.req.param("id")).id) }),
    );

    host.routes.post("/workspaces/:id/runs", async (c) => {
      const request = parseJsonBody(StartPipelineRequest, await c.req.text(), "pipeline request");
      return c.json({ run: await start(c.req.param("id"), request) }, 201);
    });

    host.routes.get("/runs/:id", (c) => c.json({ run: viewOf(requireRun(c.req.param("id"))) }));

    // Runs the waiting stage job's step now: the way to continue after the user fixed what blocked it. A stray wake may
    // be running a blocked job's step again, with its error kept; the run shows `blocked` then too, so Retry takes it.
    host.routes.post("/runs/:id/retry", (c) => {
      const run = requireRun(c.req.param("id"));
      const job = host.jobs
        .list({ kind: STAGE_JOB, key: run.workspace_id, states: ["running", "waiting"] })
        .find(
          (found) =>
            (found.subject as StageSubject).runId === run.id &&
            (found.state === "waiting" || found.error !== null),
        );
      if (!job) throw new ApiError(409, "run_not_waiting", "The run has no waiting job to retry");
      // A restart or a stray wake re-runs `await` without this mark, so the turn only blocks again. Only Retry starts
      // a fresh agent.
      const open = latestTurn(run.id);
      if (job.step === "await" && job.error !== null && open?.report === null) {
        host.store.run("UPDATE pipelines_turns SET error = ? WHERE id = ?", job.error, open.id);
      }
      // A wake during a running step applies when it settles, so a step that read the turn before the mark runs again.
      if (job.state === "waiting") host.jobs.retry(job.id);
      else host.jobs.wake(STAGE_JOB, run.workspace_id);
      publish(run.workspace_id);
      return c.json({ run: viewOf(requireRun(run.id)) });
    });

    host.routes.post("/runs/:id/cancel", (c) => {
      const run = requireRun(c.req.param("id"));
      stop(run.id, "Stopped by the user");
      return c.json({ run: viewOf(requireRun(run.id)) });
    });
  },
};
