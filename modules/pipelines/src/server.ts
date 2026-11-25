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
  type AnswerStageRequest,
  type AskStageRequest,
  type ChangedFileList,
  GATE_LOG_HEADING,
  logTail,
  type PipelineEvent,
  type PipelineGateRun,
  type PipelineRun,
  type PipelineRunState,
  type PipelineSource,
  type PipelineStage,
  type PipelineTurn,
  type PipelineTurnKind,
  parseJsonBody,
  type StageQuestion,
  type StageReport,
  type StageRole,
  StartPipelineRequest,
  stageGroups,
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
  // Why the turn's agent failed, set by Fresh agent when it starts a fresh agent for the turn.
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
  // The member stage names whose findings a fix turn holds, as JSON (ADR 0178). Null on other turns and older fixes.
  "ALTER TABLE pipelines_turns ADD COLUMN fix_for TEXT",
  // The turn got the "ended without a report" reminder (ADR 0169), so a second end blocks; it survives a restart.
  "ALTER TABLE pipelines_turns ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0",
  // The model a turn's agent reported on. A reused worker serves the later fix turns too, so a reported turn keeps
  // its own model instead of reading the agent's newest one.
  "ALTER TABLE pipelines_turns ADD COLUMN model TEXT",
  // A stage agent's question to the chat that answers it (ADR 0179). `state` is `open` or `answered`.
  `CREATE TABLE pipelines_questions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    asked_agent_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  )`,
  "CREATE INDEX pipelines_questions_by_turn ON pipelines_questions (turn_id)",
  // The red gate results of the run, as a JSON list of `GateRed` (ADR 0178). On the run, not in the job's checkpoint:
  // the round-limit approval and Retry build a fix outside the job.
  "ALTER TABLE pipelines_runs ADD COLUMN gate_reds TEXT NOT NULL DEFAULT '[]'",
  // The worker turn's report was refused once for uncommitted files, so its next report is taken and `decide` blocks
  // the stage instead; it survives a restart.
  "ALTER TABLE pipelines_turns ADD COLUMN commit_reminded INTEGER NOT NULL DEFAULT 0",
  // The state of each gate round, as a JSON list of `PipelineGateRun` (ADR 0178): the job's checkpoint holds only the
  // current round, and the view must tell gates that run from a group that waits on its fix.
  "ALTER TABLE pipelines_runs ADD COLUMN gate_runs TEXT NOT NULL DEFAULT '[]'",
  // When the user paused the run (ADR 0187). The run stays `running`; the stage job's steps wait while this is set.
  "ALTER TABLE pipelines_runs ADD COLUMN paused_at INTEGER",
  // How often Retry sent the turn back to its agent, counting the first try: the turn view shows it.
  "ALTER TABLE pipelines_turns ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1",
  // Retry asked the turn's agent to continue; the failure text waits here until `await` sends the continue message.
  "ALTER TABLE pipelines_turns ADD COLUMN retry_error TEXT",
  // The turn got the one "your model call failed" nudge (ADR 0201), so a second server error blocks; Retry clears it.
  "ALTER TABLE pipelines_turns ADD COLUMN error_nudged INTEGER NOT NULL DEFAULT 0",
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
  gate_reds: string;
  gate_runs: string;
  paused_at: number | null;
  created_at: number;
  ended_at: number | null;
}

/** A gate member that ended red in a gate round: a failed or cancelled action, or a missing fail-first proof. */
interface GateRed {
  round: number;
  stage: string;
  message: string;
  logPath?: string;
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
  fix_for: string | null;
  reminded: number;
  commit_reminded: number;
  attempts: number;
  retry_error: string | null;
  error_nudged: number;
  model: string | null;
  created_at: number;
  reported_at: number | null;
}

interface QuestionRow {
  id: string;
  run_id: string;
  turn_id: string;
  agent_id: string;
  asked_agent_id: string;
  question: string;
  answer: string | null;
  state: StageQuestion["state"];
  created_at: number;
  answered_at: number | null;
}

const questionToView = (row: QuestionRow): StageQuestion => ({
  id: row.id,
  runId: row.run_id,
  turnId: row.turn_id,
  agentId: row.agent_id,
  askedAgentId: row.asked_agent_id,
  question: row.question,
  ...(row.answer === null ? {} : { answer: row.answer }),
  state: row.state,
  createdAt: row.created_at,
  ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
});

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
 * `round` is the gate round that `places` belong to. A place, by gate stage name, is the gate to run and how often a
 * restart cut it off (ADR 0178 rule 22).
 */
interface StageCheckpoint {
  boot?: string;
  /** `await` saw the run paused; the first `await` after Resume reads this (ADR 0187). */
  paused?: true;
  round?: number;
  places?: Record<string, { gate: number; attempt: number }>;
}

/** How much of a failed gate's log goes into the run's message. */
const LOG_TAIL_CHARS = 4096;
const MAX_FAILED_TESTS_LISTED = 10;
/** How many uncommitted files the check reads; more than this counts as this many. */
const UNCOMMITTED_LIMIT = 1000;

/** The first `max` paths, then how many more there are. */
const pathList = (paths: readonly string[], max: number) =>
  paths.length > max
    ? `${paths.slice(0, max).join(", ")} and ${paths.length - max} more`
    : paths.join(", ");

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

/** `liveModel` is what the turn's agent answers on now, for a turn that has not reported; see `runToView`. */
const turnToView = (
  row: TurnRow,
  liveModel?: string,
  question?: PipelineTurn["question"],
): PipelineTurn => {
  const model = row.model ?? liveModel;
  return {
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
    ...(model === undefined ? {} : { model }),
    createdAt: row.created_at,
    ...(row.reported_at === null ? {} : { reportedAt: row.reported_at }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.attempts > 1 ? { attempts: row.attempts } : {}),
    ...(row.model_note === null ? {} : { modelNote: row.model_note }),
    ...(row.fix_for === null ? {} : { fixFor: JSON.parse(row.fix_for) as string[] }),
    ...(question ? { question } : {}),
  };
};

/**
 * `liveModel` reads the physical model an agent's newest answer ran on. Only a running run uses it, and only for a
 * turn that has not reported and has no error, so its open turn follows its agent while the agent works.
 * `questionOf` gives an open turn's open stage question (ADR 0179).
 */
const runToView = (
  row: RunRow,
  turns: readonly TurnRow[],
  blocked?: string,
  liveModel?: (agentId: string) => string | undefined,
  questionOf?: (turn: TurnRow) => PipelineTurn["question"],
): PipelineRun => ({
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
  ...(row.paused_at !== null && row.state === "running" ? { paused: true as const } : {}),
  tests: JSON.parse(row.tests) as TestProof[],
  turns: turns.map((turn) =>
    turn.report === null && turn.error === null
      ? turnToView(turn, liveModel?.(turn.agent_id), questionOf?.(turn))
      : turnToView(turn),
  ),
  gateRuns: JSON.parse(row.gate_runs) as PipelineGateRun[],
  createdAt: row.created_at,
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
});

/** Adds the new tests to the manifest, by name. A repeated name takes the new proof; no test is removed. */
function mergeTests(manifest: readonly TestProof[], reported: readonly TestProof[]): TestProof[] {
  const byName = new Map(manifest.map((test) => [test.name, test]));
  for (const test of reported) byName.set(test.name, test);
  return [...byName.values()];
}

/** `reused` says the worker made the change this brief revises. */
const taskPrompt = (
  stage: PipelineStage,
  pipeline: string,
  turnId: string,
  briefPath: string,
  brief: string,
  reused: boolean,
) =>
  [
    reused
      ? `Your change came back with a new brief. You are the "${stage.name}" stage of pipeline "${pipeline}". Do what the brief asks.`
      : `You are the "${stage.name}" stage of pipeline "${pipeline}". Implement the brief.`,
    "",
    `Turn: ${turnId}`,
    "",
    `The brief is the workspace artifact ${briefPath}. Its text is below.`,
    "For each new test, prove it can fail: run it before the code exists, or run it with the code it covers broken on purpose and then restored. Keep that failing run as a workspace artifact: that is its proof.",
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
  taskReport?: string,
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
    "The worker listed these new tests, each with the artifact that shows it can fail:",
    ...bullets(tests),
    "Open each proof and check that it shows the test failing for the right reason. Check that every test the change adds is in this list; a test that is not listed is a finding.",
    "Check that each test the brief suggests is there, or that the worker's report says why it is not.",
    ...(taskReport ? [`The worker's report: ${taskReport}`] : []),
    ...(stage.role === "adversarial-reviewer"
      ? ["Name each edge case or failure path that no test covers."]
      : []),
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

/**
 * The fix prompt of one group round: the findings of each member that said REVISE and each red gate, under its stage
 * name. `gated` says the group has gate members, which run again after the fix (ADR 0178 rules 8-10).
 */
const fixPrompt = (
  reviews: readonly { name: string; report: StageReport }[],
  reds: readonly GateRed[],
  turnId: string,
  last: boolean,
  gated: boolean,
) => {
  const named = reviews.length + reds.length > 1;
  return [
    ...(reviews.length === 0
      ? []
      : reviews.length === 1
        ? [`The reviewer of stage "${reviews[0]?.name}" asked for changes.`]
        : [
            `The reviewers of stages ${reviews.map((review) => `"${review.name}"`).join(", ")} asked for changes.`,
          ]),
    ...reds.map((red) => `The gates of stage "${red.stage}" failed.`),
    "",
    `Turn: ${turnId}`,
    "",
    ...reviews.flatMap(({ name, report }) => [
      ...(named ? [`Stage "${name}":`] : []),
      `Reviewer summary: ${report.summary}`,
      "Findings:",
      ...(findingLines(report).length > 0 ? findingLines(report) : ["(none listed)"]),
      "",
    ]),
    // The log tail stays in the log: the worker gets its path instead.
    ...reds.flatMap((red) => [
      ...(named ? [`Stage "${red.stage}":`] : []),
      (red.message.split(`\n${GATE_LOG_HEADING}`)[0] as string).trimEnd(),
      ...(red.logPath ? [`Log: ${red.logPath}`] : []),
      "",
    ]),
    "Fix what the findings ask for. Prove each new test can fail, as before: a failing run before the code exists, or one with the code it covers broken on purpose and then restored. Keep that run as a workspace artifact.",
    gated
      ? last
        ? "This is the last fix: no review follows it. The gates run once more after it."
        : "A fresh reviewer checks the result next, and the gates run again."
      : last
        ? "This is the last fix: no review follows it."
        : "A fresh reviewer checks the result next.",
    `When you are done, call report with turn ${turnId}, a short summary, and tests: one entry for each test you added in this turn.`,
    "Your turn ends only with that report.",
  ].join("\n");
};

/** The last sentence of a block message: what Retry and Fresh agent do. */
const choicesOf = (role: StageRole) =>
  `Retry tells the same agent to continue. Fresh agent starts a fresh ${role} agent for this turn.`;

/** How many files of each scope the handoff note lists. */
const HANDOFF_FILES = 30;

const restartMessage = (turnId: string) =>
  `pi-spore restarted while you worked. Continue, then call report with this turn.\n\nTurn: ${turnId}`;

const continueMessage = (turnId: string, attempt: number, failure: string) =>
  [
    `Your last turn failed: ${failure}. This is attempt ${attempt} of this turn.`,
    "Check where you stopped (git status, your last tool results), then finish the turn and call report with this turn as before.",
    "",
    `Turn: ${turnId}`,
  ].join("\n");

const resumedMessage = (turnId: string) =>
  `The user resumed the pipeline. Finish the work, then call report with this turn.\n\nTurn: ${turnId}`;

const questionMessage = (run: RunRow, turn: TurnRow, title: string, question: QuestionRow) =>
  [
    `Stage "${turn.stage}" of pipeline run ${run.id} asks (question ${question.id}). The ${turn.role} agent "${title}" wrote:`,
    question.question,
    "Answer it from your plan with answer_stage. If the plan does not say, ask the user with request_human_input first, then call answer_stage. The stage waits for your answer.",
  ].join("\n");

const answerMessage = (question: QuestionRow, answer: string) =>
  [
    `Your orchestrator answered your question ${question.id}.`,
    `Question: ${question.question}`,
    `Answer: ${answer}`,
    "Go on with the turn, then call report with this turn.",
    "",
    `Turn: ${question.turn_id}`,
  ].join("\n");

const endedMessage = (turnId: string) =>
  `You ended your turn without calling report. Finish the work, then call report with this turn.\n\nTurn: ${turnId}`;

/**
 * A model server error that is a usage limit blocks at once: the limit resets only after hours, so a nudge would
 * fail the same way (ADR 0201). The words follow pi-ai's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`.
 */
const PROVIDER_LIMIT_ERROR =
  /usage.?limit|quota|billing|out of budget|available balance|insufficient_quota/i;

/** The one nudge of ADR 0201: the same agent goes on after a model server error. */
const errorNudgeMessage = (turnId: string, failure: string) =>
  [
    `Your model call failed: ${failure}.`,
    "Check where you stopped (git status, your last tool results), then finish the turn and call report with this turn.",
    "",
    `Turn: ${turnId}`,
  ].join("\n");

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
    const turnById = (id: string) =>
      host.store.get<TurnRow>("SELECT * FROM pipelines_turns WHERE id = ?", id);
    // A stage job that failed a step waits with its error; a running run shows it, so the user can fix and retry.
    const blockedOf = (row: RunRow): string | undefined =>
      row.state !== "running"
        ? undefined
        : (host.jobs
            .list({ kind: STAGE_JOB, key: row.workspace_id, states: NOT_ENDED })
            .find((job) => (job.subject as StageSubject).runId === row.id && job.error !== null)
            ?.error ?? undefined);
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
    const loadQuestion = (id: string) =>
      host.store.get<QuestionRow>("SELECT * FROM pipelines_questions WHERE id = ?", id);
    // A lane's stage agent asks its coordinator, whose questions the runs module keeps (ADR 0003, ADR 0179).
    const openQuestionOf = (
      turn: TurnRow,
    ):
      | { id: string; question: string; askedAgentId: string; askedWorkspaceId: string }
      | undefined => {
      const workspaceId = requireRun(turn.run_id).workspace_id;
      const lane = laneLookup?.(workspaceId);
      if (lane) {
        const question = lane.openQuestion(turn.agent_id, turn.created_at);
        return (
          question && {
            id: question.id,
            question: question.question,
            askedAgentId: lane.coordinatorAgentId,
            askedWorkspaceId: lane.runWorkspaceId,
          }
        );
      }
      const row = host.store.get<QuestionRow>(
        "SELECT * FROM pipelines_questions WHERE turn_id = ? AND state = 'open' ORDER BY created_at, id LIMIT 1",
        turn.id,
      );
      return (
        row && {
          id: row.id,
          question: row.question,
          askedAgentId: row.asked_agent_id,
          askedWorkspaceId: workspaceId,
        }
      );
    };
    // Retention may have deleted the closed chat a question was asked of; the run view then names its id.
    const titleOf = (agentId: string) => unlessGone(() => agents.get(agentId))?.title ?? agentId;
    const questionView = (turn: TurnRow): PipelineTurn["question"] => {
      const question = openQuestionOf(turn);
      return question && { ...question, askedTitle: titleOf(question.askedAgentId) };
    };
    const viewOf = (row: RunRow) =>
      runToView(
        row,
        turnRows(row.id),
        blockedOf(row),
        // An ended run is a record: only a running run's open turns follow their agents' model and questions.
        row.state === "running" ? liveModelOf : undefined,
        row.state === "running" ? questionView : undefined,
      );
    const runsOf = (workspaceId: string): PipelineRun[] =>
      host.store
        .all<RunRow>(
          "SELECT * FROM pipelines_runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC",
          workspaceId,
        )
        .map(viewOf);

    // Chats and workspaces that carry a "working" label for a running run. The label is in memory only, so boot sets
    // it again.
    const labelled = new Set<string>();
    const labelledWorkspaces = new Set<string>();
    agents.beforeDeleteChat((agentId) => labelled.delete(agentId));
    /**
     * The physical model an agent's newest answer ran on, else the model its stage started it on. The agents module
     * keeps both in memory, so a running turn's model costs no session file read.
     */
    const liveModelOf = (agentId: string): string | undefined => {
      const live = unlessGone(() => agents.liveState(agentId));
      return live?.routedModel ?? live?.model;
    };
    /** What one chat or workspace works for: the run's stage and round, or the run count when it has several. */
    const workingLabel = (runs: RunRow[]): string => {
      const [run] = runs as [RunRow];
      if (runs.length > 1) return `Pipeline: ${runs.length} runs`;
      if (run.paused_at !== null) return "Pipeline paused";
      const group = groupOf(run, run.stage_index);
      // The review round, not the group's: a fix keeps the round of the reviews it answers.
      const round = reviewRound(groupTurns(run, group));
      const names = group.map((index) => stageOf(run, index).name).join(", ");
      return `Pipeline: ${names}${round >= 2 ? `, round ${round}` : ""}`;
    };
    /**
     * Marks the chat and the workspace of each running run as working, so Home and the workspace list do not show them
     * as done while the run works. A waiting_user run gives no label (its approval is the Home item), and neither does
     * an ended one (the chat has the end message). A lane's run belongs to the run's coordinator, as in `tellBlocked`,
     * and to the lane's own workspace, whose row has no worker chat of its own to read (R7).
     */
    const syncWorking = () => {
      const byAgent = new Map<string, RunRow[]>();
      const byWorkspace = new Map<string, RunRow[]>();
      for (const run of host.store.all<RunRow>(
        "SELECT * FROM pipelines_runs WHERE state = 'running' ORDER BY created_at, id",
      )) {
        byWorkspace.set(run.workspace_id, [...(byWorkspace.get(run.workspace_id) ?? []), run]);
        const agentId = unlessGone(
          () => laneLookup?.(run.workspace_id)?.coordinatorAgentId ?? run.asking_agent_id,
        );
        if (agentId !== undefined && unlessGone(() => !agents.isClosed(agentId))) {
          byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), run]);
        }
      }
      for (const [agentId, runs] of byAgent) {
        agents.setWorkingFor(agentId, "pipelines", workingLabel(runs));
        labelled.add(agentId);
      }
      for (const agentId of labelled) {
        if (byAgent.has(agentId)) continue;
        labelled.delete(agentId);
        unlessGone(() => agents.setWorkingFor(agentId, "pipelines", undefined));
      }
      for (const [workspaceId, runs] of byWorkspace) {
        agents.setWorkspaceWorkingFor(workspaceId, workingLabel(runs));
        labelledWorkspaces.add(workspaceId);
      }
      for (const workspaceId of labelledWorkspaces) {
        if (byWorkspace.has(workspaceId)) continue;
        labelledWorkspaces.delete(workspaceId);
        agents.setWorkspaceWorkingFor(workspaceId, undefined);
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
    // A failed or refused turn never reports, so the agent's status change wakes `await` to see it. So does a refused
    // delivery: Pi never takes the message, so the status does not change. A stage agent's newest answer carries the
    // model it ran on, so its activity refreshes the tab's runs event (no polling).
    agents.onChange((agentId, change) => {
      if (change !== "status" && change !== "delivery" && change !== "activity") return;
      if (agents.get(agentId).kind !== "stage") return;
      const open = host.store.get<{ workspace_id: string }>(
        `SELECT r.workspace_id FROM pipelines_turns t JOIN pipelines_runs r ON r.id = t.run_id
         WHERE t.agent_id = ? AND t.report IS NULL AND t.error IS NULL AND r.state = 'running'`,
        agentId,
      );
      if (!open) return;
      if (change === "activity") publish(open.workspace_id);
      else host.jobs.wake(STAGE_JOB, open.workspace_id);
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
      return lane
        ? `${name}, lane "${lane.lane}" (${lane.laneId}) of run "${workspaces.get(lane.runWorkspaceId).name}"`
        : name;
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

    const stagesOf = (run: RunRow) => JSON.parse(run.stages) as PipelineStage[];
    const stageOf = (run: RunRow, stageIndex: number) => stagesOf(run)[stageIndex] as PipelineStage;
    /** The stage indexes of the parallel group that holds `stageIndex` (ADR 0178). */
    const groupOf = (run: RunRow, stageIndex: number) =>
      stageGroups(stagesOf(run)).find((group) => group.includes(stageIndex)) as number[];
    // A fix turn holds the group's first index, so it is a group turn too. Failed turns are included.
    const groupTurns = (run: RunRow, group: readonly number[]) =>
      turnRows(run.id).filter((turn) => group.includes(turn.stage_index));
    // A failed turn was replaced by a fresh agent's turn, so rounds and earlier reports count only live turns.
    const liveTurn = (
      turns: readonly TurnRow[],
      kind: PipelineTurnKind,
      round: number,
      stageIndex?: number,
    ) =>
      turns.find(
        (turn) =>
          turn.error === null &&
          turn.kind === kind &&
          turn.round === round &&
          (stageIndex === undefined || turn.stage_index === stageIndex),
      );
    /** The highest round of a live review turn, 0 when there is none. */
    const reviewRound = (turns: readonly TurnRow[]) =>
      Math.max(
        0,
        ...turns
          .filter((turn) => turn.error === null && turn.kind === "review")
          .map((turn) => turn.round),
      );
    // Round numbers, not turn order: the turns of one commit share `created_at`.
    const groupRound = (turns: readonly TurnRow[]) => {
      const round = reviewRound(turns);
      return round > 0 && liveTurn(turns, "fix", round) ? round + 1 : Math.max(round, 1);
    };
    /**
     * The reviewer members that run in `round`: all in round 1, then each that said REVISE and has rounds left. Gate
     * members run every round; see `gateMembers`.
     */
    const openMembers = (
      run: RunRow,
      group: readonly number[],
      turns: readonly TurnRow[],
      round: number,
    ) =>
      round === 1
        ? group.filter((index) => isReviewer(stageOf(run, index)))
        : group.filter((index) => {
            const stage = stageOf(run, index);
            const review = liveTurn(turns, "review", round - 1, index);
            return (
              review !== undefined &&
              review.report !== null &&
              reportOf(review).verdict === "revise" &&
              round - 1 < rounds(stage) &&
              !stopsEarly(stage, review)
            );
          });
    const isReviewer = (stage: PipelineStage) =>
      stage.role !== undefined && stage.role !== "worker";
    const gateMembers = (run: RunRow, group: readonly number[]) =>
      group.filter((index) => stageOf(run, index).gates !== undefined);
    const redsOf = (run: RunRow) => JSON.parse(run.gate_reds) as GateRed[];
    const isRed = (reds: readonly GateRed[], round: number, stage: string) =>
      reds.some((red) => red.round === round && red.stage === stage);
    /** Adds the reds the stored list lacks: one entry per round and stage, whatever step wrote it first. */
    const writeReds = (runId: string, reds: readonly GateRed[]) => {
      if (reds.length === 0) return;
      const stored = redsOf(requireRun(runId));
      const fresh = reds.filter((red) => !isRed(stored, red.round, red.stage));
      host.store.run(
        "UPDATE pipelines_runs SET gate_reds = ? WHERE id = ?",
        JSON.stringify([...stored, ...fresh]),
        runId,
      );
    };
    /** Sets the state of each `(stage, round)`, adding the entries the stored list lacks. */
    const writeGateRuns = (runId: string, states: readonly PipelineGateRun[]) => {
      const stored = JSON.parse(requireRun(runId).gate_runs) as PipelineGateRun[];
      let changed = false;
      for (const next of states) {
        const entry = stored.find((run) => run.stage === next.stage && run.round === next.round);
        if (entry?.state === next.state) continue;
        if (entry) entry.state = next.state;
        else stored.push({ ...next });
        changed = true;
      }
      if (!changed) return;
      host.store.run(
        "UPDATE pipelines_runs SET gate_runs = ? WHERE id = ?",
        JSON.stringify(stored),
        runId,
      );
    };
    const modelOf = (stage: PipelineStage) =>
      stage.model ?? (stage.tier === "route" ? ROUTE_MODEL : undefined);
    const rolesTitle = (role: StageRole) => (role === "reviewer" ? "Review" : "Adversarial");
    // The tab shows the slice, so a user can tell which run a stage chat belongs to.
    const stageTitle = (run: RunRow, title: string) =>
      run.name === null ? title : `${run.name} - ${title}`;

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
      const failed = turnRows(run.id)
        .filter(
          (turn) => turn.kind === "task" && turn.stage_index === stageIndex && turn.error !== null,
        )
        .at(-1);
      const note = failed ? await handoffNote(run, failed) : "";
      const giveTask = (agentId: string, reused: boolean) => {
        const turnId = insertTurn(run, stageIndex, stage, 1, "task", "worker", agentId, {
          attempts: failed && failed.attempts + 1,
        });
        host.store.run(
          "UPDATE pipelines_runs SET worker_agent_id = ? WHERE id = ?",
          agentId,
          run.id,
        );
        agents.deliver(
          agentId,
          note + taskPrompt(stage, run.pipeline_id, turnId, briefPath, run.brief, reused),
        );
      };
      const giveFresh = (model: string | undefined): StepOutcome<StageCheckpoint> => ({
        checkpoint: { boot: bootId },
        commit: () => {
          const agent = agents.createStage(run.workspace_id, {
            role: "worker",
            title: stageTitle(run, stage.name),
            ...(model ? { model } : {}),
          });
          giveTask(agent.id, false);
        },
      });
      // Fresh agent replaced the failed task, on a reuse stage too: that worker is the one that failed. As in
      // `replaceFailed`, the local-implementer question is not asked again.
      if (failed) return giveFresh(run.worker_model ?? modelOf(stage));
      // The reused worker keeps its model, so there is no pin to question.
      if (stage.worker === "reuse") {
        const worker = requireRun(run.previous_run_id as string).worker_agent_id as string;
        return {
          checkpoint: { boot: bootId },
          commit: () => {
            // The tab names the slice that uses the chat now, not the run that made it.
            if (run.name !== null) agents.rename(worker, stageTitle(run, stage.name));
            giveTask(worker, true);
          },
        };
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
      return giveFresh(run.worker_model ?? modelOf(stage));
    };

    const insertTurn = (
      run: RunRow,
      stageIndex: number,
      stage: PipelineStage,
      round: number,
      kind: PipelineTurnKind,
      role: StageRole,
      agentId: string,
      {
        modelNote,
        fixFor,
        attempts = 1,
      }: {
        modelNote?: string | undefined;
        fixFor?: readonly string[];
        attempts?: number | undefined;
      } = {},
    ): string => {
      const turnId = host.newId();
      host.store.run(
        `INSERT INTO pipelines_turns (id, run_id, stage_index, stage, round, kind, role, agent_id, model_note, fix_for, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        turnId,
        run.id,
        stageIndex,
        stage.name,
        round,
        kind,
        role,
        agentId,
        modelNote ?? null,
        fixFor === undefined ? null : JSON.stringify(fixFor),
        attempts,
        host.now(),
      );
      return turnId;
    };

    /**
     * Starts the worker's one fix turn of a group round (ADR 0178 rule 8). Each member in `members` brings its part of
     * `round`: a reviewer its review, a gate member its red. `last` tells the worker no review follows. `fresh` is the
     * handoff note and attempt of a fresh worker that takes a failed fix turn over.
     */
    const startFix = (
      run: RunRow,
      groupStart: number,
      round: number,
      members: readonly number[],
      last: boolean,
      fresh?: { note: string; attempts: number },
    ) => {
      const worker = run.worker_agent_id as string;
      const turns = turnRows(run.id);
      const stored = redsOf(run);
      const reviews = [];
      const reds = [];
      for (const index of members) {
        const name = stageOf(run, index).name;
        const review = liveTurn(turns, "review", round, index);
        if (review) reviews.push({ name, report: reportOf(review) });
        else reds.push(stored.find((red) => red.round === round && red.stage === name) as GateRed);
      }
      const turnId = insertTurn(
        run,
        groupStart,
        stageOf(run, groupStart),
        round,
        "fix",
        "worker",
        worker,
        { fixFor: members.map((index) => stageOf(run, index).name), attempts: fresh?.attempts },
      );
      const gated = gateMembers(run, groupOf(run, groupStart)).length > 0;
      agents.deliver(worker, (fresh?.note ?? "") + fixPrompt(reviews, reds, turnId, last, gated));
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
     * The workspace's changed, staged, and untracked file paths, gitignored files left out. None without a VCS that
     * shows them. The uncommitted scope compares the working copy with the last record, so a staged change that the
     * working copy undid shows in the staged scope only.
     */
    const uncommittedFiles = async (workspaceId: string): Promise<string[]> => {
      const { ops, location } = await changesOf(workspaceId);
      if (!ops) return [];
      const [uncommitted, staged] = await Promise.all([
        ops.files(location, { kind: "uncommitted" }, UNCOMMITTED_LIMIT),
        ops.scopes.includes("staged")
          ? ops.files(location, { kind: "staged" }, UNCOMMITTED_LIMIT)
          : { files: [] },
      ]);
      return [...new Set([...uncommitted.files, ...staged.files].map((file) => file.path))].sort();
    };

    /**
     * The diff text: commits since the workspace's base, plus uncommitted and untracked files. A fix diff passes the
     * run's `fix_base` instead; null (no head when the fix started) lists no commits.
     */
    const renderChanges = async (run: RunRow, fixBase?: string | null) => {
      const { workspace, project, ops, location } = await changesOf(run.workspace_id);
      const base =
        fixBase === undefined
          ? (workspace.base ?? (await ops?.defaultBase(project)))
          : (fixBase ?? undefined);
      return ops ? renderDiff(ops, location, base) : NO_DIFF;
    };

    /**
     * The note that starts a fresh worker's first message when it takes a failed turn over (ADR 0198): what the failed
     * agent did, from its session file, and the worktree now. Tool results stay out, since a result may hold secrets.
     */
    const handoffNote = async (run: RunRow, failed: TurnRow): Promise<string> => {
      const handoff = await agents.handoff(failed.agent_id);
      const error = failed.error as string;
      const choices = `. ${choicesOf(failed.role)}`;
      const failure = error.endsWith(choices) ? error.slice(0, -choices.length) : error;
      const { workspace, project, ops, location } = await changesOf(run.workspace_id);
      const list = (heading: string, { files, truncated }: ChangedFileList) => [
        heading,
        ...(files.length === 0 ? ["(none)"] : []),
        ...files.map(
          (file) => `- ${file.status} ${file.path} (+${file.additions} -${file.deletions})`,
        ),
        ...(truncated ? ["(more files)"] : []),
      ];
      const worktree: string[] = [];
      if (!ops) worktree.push("(no version control shows the changes)");
      else {
        const base = workspace.base ?? (await ops.defaultBase(project));
        worktree.push(
          ...list(
            "Uncommitted:",
            await ops.files(location, { kind: "uncommitted" }, HANDOFF_FILES),
          ),
        );
        if (base) {
          worktree.push(
            ...list(
              `Committed since ${base}:`,
              await ops.files(location, { kind: "line", base }, HANDOFF_FILES),
            ),
          );
        }
      }
      return [
        `This is attempt ${failed.attempts + 1} of this turn. The last agent "${agents.get(failed.agent_id).title}" failed: ${failure}.`,
        ...(handoff.sessionFile ? [`Its session file: ${handoff.sessionFile}`] : []),
        ...(handoff.lastText ? ["", "Its last message:", handoff.lastText] : []),
        ...(handoff.toolCalls.length > 0
          ? [
              "",
              "Its last tool calls, oldest first:",
              ...handoff.toolCalls.map((call) => `- ${call.name} ${call.head}`),
            ]
          : []),
        "",
        "The worktree now:",
        ...worktree,
        "",
        "Check this work before you redo it. Keep what is right.",
        "",
        "---",
        "",
        "",
      ].join("\n");
    };
    const writeArtifact = (run: RunRow, path: string, text: string) =>
      artifacts.write({ scope: "workspace", id: run.workspace_id }, path, text);

    /**
     * Starts the open members of a group's round at once (ADR 0178). A member whose review of the round is live already
     * is not started again, so after Retry replaced a failed review only that member starts. A new round also opens the
     * gate round: every gate member goes back to its first gate, and `await` runs the gates.
     */
    const advanceGroup = async (
      run: RunRow,
      group: readonly number[],
      checkpoint: StageCheckpoint | undefined,
    ): Promise<StepOutcome<StageCheckpoint>> => {
      const turns = groupTurns(run, group);
      const round = groupRound(turns);
      // A Retry after a restart: the members still open lost their process, so they get the restart note here, before
      // the checkpoint takes this boot (R6.6).
      const resumed =
        checkpoint?.boot === bootId
          ? []
          : turns.filter((turn) => turn.error === null && turn.report === null);
      // Retry runs this step again in the same round: the places stay, and the proofs are not checked twice.
      const gates = gateMembers(run, group);
      const opened: StageCheckpoint = {};
      const reds: GateRed[] = [];
      const started: PipelineGateRun[] = [];
      if (gates.length > 0 && checkpoint?.round !== round) {
        opened.round = round;
        opened.places = {};
        for (const index of gates) {
          const stage = stageOf(run, index);
          opened.places[stage.name] = { gate: 0, attempt: 0 };
          // ADR 0016: the manifest grows with each fix report, so each gate round checks it (ADR 0178 rule 14).
          if (stage.fail_first !== "artifact") continue;
          for (const test of JSON.parse(run.tests) as TestProof[]) {
            if (await hasProof(run, test)) continue;
            reds.push({
              round,
              stage: stage.name,
              message: `missing fail-first proof for ${test.name} (${test.proof})`,
            });
            break;
          }
        }
        for (const index of gates) {
          const { name } = stageOf(run, index);
          started.push({
            stage: name,
            round,
            state: isRed(reds, round, name) ? "failed" : "running",
          });
        }
      }
      // A replacement after Retry keeps the diff its failed turn had, so every member of a round reads one snapshot.
      const written = turns.some((turn) => turn.kind === "review" && turn.round === round);
      let settings: RouterSettings | undefined;
      const members: { index: number; stage: PipelineStage; model?: string; note?: string }[] = [];
      for (const index of openMembers(run, group, turns, round)) {
        if (liveTurn(turns, "review", round, index)) continue;
        const stage = stageOf(run, index);
        const role = stage.role as StageRole;
        // Read only when a reviewer starts, so a group of gates alone does not depend on settings.json.
        settings ??= await loadSettings(host.home.root);
        const chosen = await reviewerModel(stage, settings);
        if (stage.min_strength_over) {
          // Checked before any reviewer exists, so a refused model creates no agent. A throw waits for a settings fix.
          if (!chosen.model) {
            throw new Error(
              `stage ${stage.name}: min_strength_over needs the ${role} model, but the stage sets no model and the ${role} role has no default; set "model" in the stage or the ${role} model in the pi-subagents settings`,
            );
          }
          const problem = notStronger(settings, [chosen.model], await workerModels(run));
          if (problem) {
            throw new Error(
              `stage ${stage.name} (min_strength_over ${stage.min_strength_over}): reviewer model ${problem}; set a reviewer model of a high enough tier in the stage or fix "tiers" in settings.json, then retry`,
            );
          }
        }
        members.push({ index, stage, ...chosen });
      }
      // Every member of the round reads the same diff, rendered once. Gates read the working copy, not a diff.
      const diff = written || members.length === 0 ? undefined : await renderChanges(run);
      const fixDiff =
        written || members.length === 0 || run.previous_run_id === null
          ? undefined
          : await renderChanges(run, run.fix_base);
      const previousReview =
        run.previous_run_id === null
          ? undefined
          : turnRows(run.previous_run_id)
              .filter((turn) => turn.kind === "review" && turn.report !== null)
              .map(reportOf)
              .at(-1);
      const fix = round > 1 ? liveTurn(turns, "fix", round - 1) : undefined;
      const tests = JSON.parse(run.tests) as TestProof[];
      // Round 1 has no fix report, so the worker's own report is what lets the reviewer check the brief's tests;
      // round 2 and later read the fix report. The group's turns hold only this stage's turns, so read the run's.
      // A fix pass run (a reused worker) keeps the prompt it had.
      const taskReport =
        round === 1 && run.previous_run_id === null
          ? turnRows(run.id)
              .filter((turn) => turn.kind === "task" && turn.error === null && turn.report !== null)
              .map(reportOf)
              .at(-1)?.summary
          : undefined;
      const starts: { member: (typeof members)[number]; prompt: (turnId: string) => string }[] = [];
      for (const member of members) {
        const { stage, index } = member;
        const paths = {
          brief: `pipelines/${run.id}/brief.md`,
          diff: `pipelines/${run.id}/${stage.name}-${round}.diff`,
        };
        if (diff !== undefined) await writeArtifact(run, paths.diff, diff);
        const fixPass: FixPass | undefined =
          run.previous_run_id === null
            ? undefined
            : {
                diff: `pipelines/${run.id}/${stage.name}-${round}-fix.diff`,
                review: previousReview,
              };
        if (fixPass && fixDiff !== undefined) await writeArtifact(run, fixPass.diff, fixDiff);
        // Round 2 and later: the member's own previous review and the group's fix for it.
        const earlier = fix
          ? {
              review: reportOf(liveTurn(turns, "review", round - 1, index) as TurnRow),
              fix: reportOf(fix),
            }
          : undefined;
        starts.push({
          member,
          prompt: (turnId) =>
            reviewPrompt(stage, round, turnId, paths, tests, earlier, fixPass, taskReport),
        });
      }
      return {
        checkpoint: { ...checkpoint, boot: bootId, ...opened },
        commit: () => {
          writeReds(run.id, reds);
          writeGateRuns(run.id, started);
          for (const turn of resumed) agents.deliver(turn.agent_id, restartMessage(turn.id));
          for (const { member, prompt } of starts) {
            const role = member.stage.role as StageRole;
            const agent = agents.createStage(run.workspace_id, {
              role,
              title: stageTitle(run, `${rolesTitle(role)} ${round}`),
              ...(member.model ? { model: member.model } : {}),
            });
            const turnId = insertTurn(
              run,
              member.index,
              member.stage,
              round,
              "review",
              role,
              agent.id,
              { modelNote: member.note },
            );
            agents.deliver(agent.id, prompt(turnId));
          }
        },
      };
    };

    const advance = async ({
      subject,
      checkpoint,
    }: {
      subject: StageSubject;
      checkpoint: StageCheckpoint | undefined;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      // Retry or a restart runs this step again while the user answers the local-implementer question.
      const waiting = loadRun(subject.runId);
      if (waiting?.state === "waiting_user" && waiting.stage_index === subject.stageIndex) {
        return { wait: true };
      }
      const run = runOf(subject);
      if (!run) return { next: null };
      if (run.paused_at !== null) return { wait: true };
      const stage = stageOf(run, subject.stageIndex);
      if (stage.role === "worker") return advanceWorker(run, stage, subject.stageIndex);
      return advanceGroup(run, groupOf(run, subject.stageIndex), checkpoint);
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

    // Action runs whose end wakes the stage job. In memory: after a restart the next await step watches them again.
    const watched = new Set<string>();
    const watch = (workspaceId: string, actionRunId: string) => {
      if (watched.has(actionRunId)) return;
      watched.add(actionRunId);
      actions
        .wait(actionRunId)
        .then(() => host.jobs.wake(STAGE_JOB, workspaceId))
        .catch((error: unknown) =>
          host.log.error("A gate action's end did not wake its stage", {
            actionRunId,
            error: String(error),
          }),
        );
    };

    /**
     * Moves each gate member of the checkpoint's round as far as it can without waiting (ADR 0178 rules 13, 15, 24).
     * The key holds the round, gate, and attempt, so a step that runs again gets the same action run back instead of
     * starting another. A member that waits on a running action wakes the job when it ends. An unknown action throws:
     * the job waits with the error until the user fixes config.toml and retries. `done` is true when every gate member
     * is green or red.
     */
    const driveGates = async (
      run: RunRow,
      group: readonly number[],
      round: number,
      start: NonNullable<StageCheckpoint["places"]>,
    ) => {
      const places = { ...start };
      const known = redsOf(run);
      const reds: GateRed[] = [];
      let done = true;
      for (const index of gateMembers(run, group)) {
        const stage = stageOf(run, index);
        if (isRed(known, round, stage.name)) continue;
        const gates = stage.gates as string[];
        let { gate, attempt } = places[stage.name] ?? { gate: 0, attempt: 0 };
        while (gate < gates.length) {
          const name = gates[gate] as string;
          const started = await actions
            .start(run.workspace_id, name, "pipeline", {
              key: `${run.id}:${stage.name}:${round}:${name}:${attempt}`,
            })
            .catch(async (error: unknown) => {
              if (!(error instanceof ApiError) || error.code !== "action_not_found") throw error;
              const project = await projects.get(workspaces.get(run.workspace_id).projectId);
              throw new Error(
                `stage "${stage.name}": no action "${name}" in ${join(project.path, ".pi-spore", "config.toml")}. Add it there, then Retry.`,
              );
            });
          if (started.status === "succeeded") {
            gate += 1;
            attempt = 0;
          } else if (started.status === "interrupted") {
            attempt += 1;
          } else if (started.status === "failed" || started.status === "cancelled") {
            const { text } = await actions.readLog(started.id, undefined);
            reds.push({
              round,
              stage: stage.name,
              message: gateFailureMessage(name, started.error, text),
              logPath: started.logPath,
            });
            break;
          } else {
            watch(run.workspace_id, started.id);
            done = false;
            break;
          }
        }
        places[stage.name] = { gate, attempt };
      }
      return { places, reds, done };
    };

    /** `problem` follows the agent's name; a failed `provider` names the model server instead. */
    const failedMessage = (turn: TurnRow, problem: string, provider?: string) => {
      const agent = `the ${turn.role} agent "${agents.get(turn.agent_id).title}"`;
      const what =
        provider === undefined
          ? `${agent} ${problem}`
          : `the model server ${provider} failed for ${agent}: ${problem}`;
      return `stage ${turn.stage}: ${what}. ${choicesOf(turn.role)}`;
    };

    /**
     * Waits until no turn of the group is open and every gate member of the round is green or red. Each open turn
     * reports, or blocks the step with its agent's failure.
     */
    const awaitReport = async ({
      subject,
      checkpoint: saved,
    }: {
      subject: StageSubject;
      checkpoint: StageCheckpoint | undefined;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      const run = runOf(subject);
      if (!run) return { next: null };
      // A paused run reminds no one and blocks nothing (ADR 0187). `paused` leaves the checkpoint at the first await
      // after Resume.
      const { paused: wasPaused, ...checkpoint } = saved ?? {};
      if (run.paused_at !== null)
        return { wait: true, checkpoint: { ...checkpoint, paused: true } };
      const group = groupOf(run, subject.stageIndex);
      const turns = groupTurns(run, group);
      // Retry marked these failed; a fresh agent of each role takes its turn over.
      const failed = turns.filter(
        (turn) =>
          turn.error !== null &&
          !turns.some(
            (other) =>
              other.error === null &&
              other.stage_index === turn.stage_index &&
              other.kind === turn.kind &&
              other.round === turn.round,
          ),
      );
      // The last one: a fix that failed again after Fresh agent leaves both rows failed, and the newest has the work.
      const failedFix = failed.findLast((turn) => turn.kind === "fix");
      if (failedFix) {
        const replaced = await replaceFailed(run, group, failedFix);
        // Pause can land while the handoff note reads the session file and the worktree (ADR 0187).
        return loadRun(run.id)?.paused_at == null
          ? replaced
          : { wait: true, checkpoint: { ...checkpoint, paused: true } };
      }
      if (failed.length > 0) {
        return { next: "advance", commit: () => failed.forEach(renameFailed) };
      }
      const open = turns.filter((turn) => turn.error === null && turn.report === null);
      // The gates run while the reviewers work, never while the worker fixes: they must see the fixed code.
      const round = checkpoint?.round;
      const gated =
        round === undefined || open.some((turn) => turn.kind === "fix")
          ? undefined
          : await driveGates(run, group, round, checkpoint?.places ?? {});
      // A member whose gates all ran green passed its round; one with a red of the round failed it.
      const ended: PipelineGateRun[] = [];
      if (gated && round !== undefined) {
        for (const index of gateMembers(run, group)) {
          const { name, gates } = stageOf(run, index);
          if (isRed(gated.reds, round, name)) ended.push({ stage: name, round, state: "failed" });
          else if (gated.places[name]?.gate === (gates as string[]).length) {
            ended.push({ stage: name, round, state: "passed" });
          }
        }
      }
      // Gate progress rides on every outcome, the restart one too: a group with no reviewer has no agent to wake it.
      const withGates = (outcome: StepOutcome<StageCheckpoint>): StepOutcome<StageCheckpoint> => ({
        ...outcome,
        checkpoint: {
          ...checkpoint,
          ...outcome.checkpoint,
          ...(gated ? { places: gated.places } : {}),
        },
        commit: () => {
          writeReds(run.id, gated?.reds ?? []);
          writeGateRuns(run.id, ended);
          outcome.commit?.();
        },
      });
      if (open.length === 0) return withGates(gated?.done === false ? { wait: true } : {});
      // Pause can land while the reads below wait on session files. Each effect or block after a read checks again
      // (ADR 0187).
      const holdIfPaused = () =>
        loadRun(run.id)?.paused_at == null
          ? undefined
          : withGates({ wait: true, checkpoint: { paused: true } });
      // An agent that asked its asking chat waits for the answer, whose delivery starts it again (ADR 0179).
      const waitingOf = (turns: readonly TurnRow[]) =>
        turns.filter((turn) => !openQuestionOf(turn));
      // The resume message covers the restart reminder. A busy agent reports when its turn ends.
      const resume = (turns: readonly TurnRow[]) => {
        const resumed = turns.filter((turn) => agents.get(turn.agent_id).status !== "busy");
        return () => {
          for (const turn of resumed) {
            host.store.run("UPDATE pipelines_turns SET reminded = 0 WHERE id = ?", turn.id);
            agents.deliver(turn.agent_id, resumedMessage(turn.id));
          }
        };
      };
      // The server restarted while the agents worked. Their processes are gone, so each gets one reminder (R6.6).
      const restart = (turns: readonly TurnRow[]) => () => {
        for (const turn of turns) agents.deliver(turn.agent_id, restartMessage(turn.id));
      };
      // Retry asked these agents to continue their failed turns: each gets one continue message, and the other turns
      // what this step would give them now.
      const continued = open.filter((turn) => turn.retry_error !== null);
      if (continued.length > 0) {
        const others = waitingOf(open.filter((turn) => turn.retry_error === null));
        const wake = wasPaused
          ? resume(others)
          : checkpoint.boot !== bootId
            ? restart(others)
            : undefined;
        // Pause can land while the gates are read; `retry_error` then waits for Resume (ADR 0187).
        const paused = holdIfPaused();
        if (paused) return paused;
        return withGates({
          wait: true,
          checkpoint: { boot: bootId },
          commit: () => {
            for (const turn of continued) {
              host.store.run(
                "UPDATE pipelines_turns SET attempts = attempts + 1, reminded = 0, retry_error = NULL, error_nudged = 0 WHERE id = ?",
                turn.id,
              );
              agents.deliver(
                turn.agent_id,
                continueMessage(turn.id, turn.attempts + 1, turn.retry_error as string),
              );
            }
            wake?.();
          },
        });
      }
      // A live agent whose model call failed gets one nudge to go on before the stage blocks (ADR 0201).
      const nudge: { turn: TurnRow; error: string }[] = [];
      for (const turn of open) {
        const failure = await agents.turnError(turn.agent_id);
        const paused = holdIfPaused();
        if (paused) return paused;
        if (failure !== undefined) {
          if (
            failure.provider !== undefined &&
            turn.error_nudged === 0 &&
            !PROVIDER_LIMIT_ERROR.test(failure.error)
          ) {
            nudge.push({ turn, error: failure.error });
            continue;
          }
          throw new Error(
            failure.provider === undefined
              ? failedMessage(turn, `failed: ${failure.error}`)
              : failedMessage(turn, failure.error, failure.provider),
          );
        }
      }
      const waiting = waitingOf(open);
      if (wasPaused) {
        return withGates({
          wait: true,
          checkpoint: { boot: bootId },
          commit: resume(waiting),
        });
      }
      if (checkpoint.boot !== bootId) {
        return withGates({
          wait: true,
          checkpoint: { boot: bootId },
          commit: restart(waiting),
        });
      }
      // The agent that ends its turn without a report gets one reminder, then the stage blocks (ADR 0169). An agent
      // that asked its asking chat waits for the answer instead (ADR 0179); it may have asked while endedRun read.
      const remind: TurnRow[] = [];
      for (const turn of waiting) {
        if (!(await agents.endedRun(turn.agent_id))) continue;
        // The agent may have done the whole turn and reported while the awaits above read its session file.
        if (turnById(turn.id)?.report !== null || openQuestionOf(turn)) continue;
        const paused = holdIfPaused();
        if (paused) return paused;
        if (turn.reminded === 1) {
          throw new Error(failedMessage(turn, "ended its turn twice without a report"));
        }
        remind.push(turn);
      }
      const paused = holdIfPaused();
      if (paused) return paused;
      return withGates({
        wait: true,
        commit: () => {
          for (const turn of remind) {
            host.store.run("UPDATE pipelines_turns SET reminded = 1 WHERE id = ?", turn.id);
            agents.deliver(turn.agent_id, endedMessage(turn.id));
          }
          for (const { turn, error } of nudge) {
            host.store.run("UPDATE pipelines_turns SET error_nudged = 1 WHERE id = ?", turn.id);
            agents.deliver(turn.agent_id, errorNudgeMessage(turn.id, error));
          }
        },
      });
    };

    // The failed agent stays, renamed.
    const renameFailed = (turn: TurnRow) => {
      agents.rename(turn.agent_id, `${agents.get(turn.agent_id).title} (failed)`);
      // The old agent must not get its refused task later, for example when the workspace resumes.
      agents.dropDeliveries(turn.agent_id);
    };

    /** Retry marked a fix turn failed: a fresh worker takes it over, with the same members' findings. */
    const replaceFailed = async (
      run: RunRow,
      group: readonly number[],
      turn: TurnRow,
    ): Promise<StepOutcome<StageCheckpoint>> => {
      const groupStart = group[0] as number;
      const stage = stageOf(run, groupStart);
      const model = run.worker_model ?? modelOf(stage);
      // A fix row from before parallel groups names its one member in `stage`.
      const names = turn.fix_for === null ? [turn.stage] : (JSON.parse(turn.fix_for) as string[]);
      const members = group.filter((index) => names.includes(stageOf(run, index).name));
      const last = openMembers(run, group, groupTurns(run, group), turn.round + 1).length === 0;
      const note = await handoffNote(run, turn);
      return {
        wait: true,
        checkpoint: { boot: bootId },
        commit: () => {
          renameFailed(turn);
          const worker = agents.createStage(run.workspace_id, {
            role: "worker",
            title: stageTitle(run, stage.name),
            ...(model ? { model } : {}),
          });
          host.store.run(
            "UPDATE pipelines_runs SET worker_agent_id = ? WHERE id = ?",
            worker.id,
            run.id,
          );
          startFix({ ...run, worker_agent_id: worker.id }, groupStart, turn.round, members, last, {
            note,
            attempts: turn.attempts + 1,
          });
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

    /** A REVISE on the member's last round, with no fix pass left: the user decides (R6.4). */
    const atLimit = (stage: PipelineStage, round: number) =>
      round >= rounds(stage) && stage.fix_passes !== 1;

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

    /** Files one round-limit approval for every member in `limited`, the round's reviews at their limit. */
    const askRoundLimit = (run: RunRow, limited: readonly TurnRow[]) => {
      const reviews = limited.map((review) => {
        const stage = stageOf(run, review.stage_index);
        const message = `Stage ${stage.name} used its ${rounds(stage)} review round(s) and the reviewer still asks for changes`;
        return { stage, message, report: reportOf(review) };
      });
      const names = reviews.map(({ stage }) => `"${stage.name}"`).join(", ");
      const first = limited[0] as TurnRow;
      const group = groupOf(run, first.stage_index);
      const last = openMembers(run, group, groupTurns(run, group), first.round + 1).length === 0;
      const reds = redsOf(run);
      const redNames = gateMembers(run, group)
        .map((index) => stageOf(run, index).name)
        .filter((name) => isRed(reds, first.round, name));
      const approval = approvals.file(
        { agentId: run.asking_agent_id, workspaceId: run.workspace_id },
        {
          kind: ROUND_LIMIT,
          title: `Review round limit in ${workspaceLabel(run.workspace_id)}: ${reviews.length === 1 ? "stage" : "stages"} ${names} of pipeline ${run.pipeline_id}`,
          reason: [
            ...reviews.flatMap(({ message, report }, index) => [
              ...(index > 0 ? [""] : []),
              `${message}.`,
              `Reviewer: ${report.summary}`,
              "Findings:",
              ...(findingLines(report).length > 0 ? findingLines(report) : ["(none listed)"]),
            ]),
            ...(redNames.length === 0
              ? []
              : [
                  "",
                  `The red gates of ${redNames.length === 1 ? "stage" : "stages"} ${redNames.map((name) => `"${name}"`).join(", ")} go into the fix either way.`,
                ]),
            "",
            last
              ? "Fix: the worker makes one last fix for these findings, with no review after it, and the run goes on."
              : "Fix: the worker makes one fix for these findings and the others of this round; the stages with rounds left review it.",
            redNames.length === 0
              ? "Accept: the run goes on without a fix."
              : "Accept: the fix leaves out these findings; it still fixes the red gates.",
            "Decline: the run stops.",
          ].join("\n"),
          subject: {
            runId: run.id,
            stage: reviews.map(({ stage }) => stage.name).join(", "),
            action: "fix",
          },
        },
      );
      host.store.run(
        "UPDATE pipelines_runs SET state = 'waiting_user', approval_id = ?, message = ? WHERE id = ?",
        approval.id,
        reviews.map(({ message }) => message).join("; "),
        run.id,
      );
    };

    /** Picks what comes next from the group's turns and red gates, by round. The checkpoint says which gate round ran. */
    const decide = async ({
      subject,
      checkpoint,
    }: {
      subject: StageSubject;
      checkpoint: StageCheckpoint | undefined;
    }): Promise<StepOutcome<StageCheckpoint>> => {
      const run = loadRun(subject.runId);
      if (!run || run.stage_index !== subject.stageIndex) return { next: null };
      // Retry or a restart runs this step again while the user decides; it keeps waiting. A decline ends the run.
      if (run.state === "waiting_user") return { wait: true };
      if (run.state !== "running") return { next: null };
      if (run.paused_at !== null) return { wait: true };
      // Uncommitted work never passes: the throw blocks the stage until a commit and Retry (ADR 0140).
      const uncommitted = await uncommittedFiles(run.workspace_id);
      if (uncommitted.length > 0) {
        const count = uncommitted.length === 1 ? "1 file" : `${uncommitted.length} files`;
        throw new Error(
          `uncommitted changes in ${workspaceLabel(run.workspace_id)}: ${count} (${pathList(uncommitted, 5)}). Commit them, then Retry.`,
        );
      }
      // The user accepted the round limit and nothing is left to fix: the group ends.
      if (run.approval_id !== null) return { next: "finish" };
      // The worker stage ends when its task reported.
      if (stageOf(run, subject.stageIndex).role === "worker") return { next: "finish" };
      const group = groupOf(run, subject.stageIndex);
      const turns = groupTurns(run, group);
      const round = reviewRound(turns);
      const hasGates = gateMembers(run, group).length > 0;
      const reds = redsOf(run);
      const firstRed = (gateRound: number) =>
        gateMembers(run, group)
          .map((index) =>
            reds.find((red) => red.round === gateRound && red.stage === stageOf(run, index).name),
          )
          .find((red) => red !== undefined);
      const failOn = (red: GateRed): StepOutcome<StageCheckpoint> => ({
        next: null,
        commit: () => endRun(run.id, "failed", red.message),
      });
      const fix = liveTurn(turns, "fix", round);
      if (fix) {
        // The user chose a last fix at the round limit: its turn is open.
        if (fix.report === null)
          return { next: "await", checkpoint: { ...checkpoint, boot: bootId } };
        // After a fix the gates run again, with the next review round or alone (ADR 0178 rules 9, 10).
        if (
          openMembers(run, group, turns, round + 1).length > 0 ||
          (hasGates && checkpoint?.round !== round + 1)
        ) {
          return { next: "advance" };
        }
        // The final gate run ran: it gets no fix.
        const red = firstRed(round + 1);
        return red ? failOn(red) : { next: "finish" };
      }
      const reviews = group.flatMap((index) => liveTurn(turns, "review", round, index) ?? []);
      for (const review of reviews) {
        const stage = stageOf(run, review.stage_index);
        const weak = await reviewerWeakness(run, stage, review);
        if (weak) {
          return {
            next: null,
            commit: () =>
              endRun(run.id, "failed", `R4.4: stage ${stage.name}: reviewer model ${weak}`),
          };
        }
      }
      // A group with no reviewer gets no fix: its first red gate ends the run (ADR 0178 rule 11).
      if (!group.some((index) => isReviewer(stageOf(run, index)))) {
        const red = firstRed(groupRound(turns));
        return red ? failOn(red) : { next: "finish" };
      }
      const redGates = gateMembers(run, group).filter((index) =>
        isRed(reds, groupRound(turns), stageOf(run, index).name),
      );
      const revisers = reviews.filter((review) => reportOf(review).verdict === "revise");
      if (revisers.length === 0 && redGates.length === 0) return { next: "finish" };
      const limited = revisers.filter((review) => atLimit(stageOf(run, review.stage_index), round));
      if (limited.length > 0) return { wait: true, commit: () => askRoundLimit(run, limited) };
      const last = openMembers(run, group, turns, round + 1).length === 0;
      const members = [...revisers.map((review) => review.stage_index), ...redGates].sort(
        (a, b) => a - b,
      );
      return {
        next: "await",
        checkpoint: { ...checkpoint, boot: bootId },
        commit: () => startFix(run, group[0] as number, round, members, last),
      };
    };

    /** The last step of every group: starts the next group's job, or ends the run. */
    const finish = async ({ subject }: { subject: StageSubject }): Promise<StepOutcome<never>> => {
      const run = runOf(subject);
      if (!run) return { next: null };
      if (run.paused_at !== null) return { wait: true };
      const next = (groupOf(run, subject.stageIndex).at(-1) as number) + 1;
      return {
        next: null,
        commit: () => {
          if (next >= stagesOf(run).length) {
            endRun(run.id, "passed");
            return;
          }
          host.store.run(
            "UPDATE pipelines_runs SET stage_index = ?, approval_id = NULL WHERE id = ?",
            next,
            run.id,
          );
          host.jobs.start(
            STAGE_JOB,
            { runId: run.id, stageIndex: next },
            { key: run.workspace_id },
          );
        },
      };
    };

    type StageStep = JobStep<StageSubject, StageCheckpoint>["run"];
    /**
     * Pause can land while a step awaits its reads, and the step's commit would then start a turn. A step that ends on
     * a paused run takes no effect and waits (ADR 0187).
     */
    const unlessPaused =
      (step: StageStep): StageStep =>
      async (context) => {
        const outcome = await step(context);
        const run = loadRun(context.subject.runId);
        return run?.state === "running" && run.paused_at !== null ? { wait: true } : outcome;
      };

    const steps: JobStep<StageSubject, StageCheckpoint>[] = [
      { name: "advance", run: unlessPaused(advance) },
      { name: "await", run: awaitReport },
      { name: "decide", run: unlessPaused(decide) },
      // A job stored on the gate step before gate members goes back to `advance`, which opens the gate round.
      { name: "gate", run: async () => ({ next: "advance" }) },
      { name: "finish", run: finish },
    ];
    host.jobs.define(STAGE_JOB, steps);

    const report = async (
      caller: BridgeCaller,
      request: StageReport,
    ): Promise<{ turn: PipelineTurn }> => {
      // The transaction is synchronous, so the router's records are read before it.
      let routing: string | null = null;
      // The model of the answer that produced this report stays on the turn: a reused worker answers later fix turns
      // too, and may do so on another model.
      const model = liveModelOf(caller.agentId) ?? null;
      const open = host.store.get<TurnRow>(
        "SELECT * FROM pipelines_turns WHERE id = ?",
        request.turn,
      );
      // A worker that reports with uncommitted files is told once, by name; its next report is taken and `decide`
      // blocks the stage. The flag is written outside the transaction, so the refusal does not roll it back.
      if (
        open?.role === "worker" &&
        open.agent_id === caller.agentId &&
        open.report === null &&
        open.commit_reminded === 0
      ) {
        const run = requireRun(open.run_id);
        const uncommitted = await uncommittedFiles(run.workspace_id);
        if (uncommitted.length > 0) {
          host.store.run("UPDATE pipelines_turns SET commit_reminded = 1 WHERE id = ?", open.id);
          throw new ApiError(
            409,
            "uncommitted_changes",
            `The workspace has uncommitted files: ${pathList(uncommitted, 10)}. Commit them, then call report again with turn ${open.id}.`,
          );
        }
      }
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
        const run = requireRun(row.run_id);
        // The reviews of one group round run side by side, so only a turn of another kind or round closes a turn.
        const group = groupOf(run, row.stage_index);
        const closed =
          row.error !== null ||
          turnRows(run.id).some(
            (other) =>
              (other.created_at > row.created_at ||
                (other.created_at === row.created_at && other.id > row.id)) &&
              !(
                other.kind === "review" &&
                other.round === row.round &&
                group.includes(other.stage_index)
              ),
          );
        if (closed)
          throw new ApiError(409, "turn_closed", `Turn ${row.id} is closed; a later turn is open`);
        if (row.report !== null) return row;
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
          "UPDATE pipelines_turns SET report = ?, reported_at = ?, routing = ?, model = ? WHERE id = ?",
          JSON.stringify(request),
          reportedAt,
          routing,
          model,
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
        return {
          ...row,
          report: JSON.stringify(request),
          routing,
          model,
          reported_at: reportedAt,
        };
      });
      publish(requireRun(turn.run_id).workspace_id);
      return { turn: turnToView(turn) };
    };

    /**
     * The caller's open turn and its run, or 409 `turn_closed` when the caller has no open turn. An open turn is a turn
     * of a running run with no report and no error; a review group has several (ADR 0178). Answering and the run view
     * use the same rule (ADR 0179).
     */
    const requireOpenTurn = (caller: BridgeCaller) => {
      const turn = host.store.get<TurnRow>(
        `SELECT t.* FROM pipelines_turns t JOIN pipelines_runs r ON r.id = t.run_id
         WHERE t.agent_id = ? AND t.report IS NULL AND t.error IS NULL AND r.state = 'running'`,
        caller.agentId,
      );
      if (!turn)
        throw new ApiError(
          409,
          "turn_closed",
          "Your turn is closed; no open turn of a run is yours",
        );
      return { run: requireRun(turn.run_id), turn };
    };

    const askStage = async (
      caller: BridgeCaller,
      request: AskStageRequest,
    ): Promise<StageQuestion> => {
      if (agents.get(caller.agentId).kind !== "stage")
        throw new ApiError(403, "not_a_stage", "Only a pipeline stage agent asks the asking chat");
      if (laneLookup?.(caller.workspaceId))
        throw new ApiError(
          403,
          "in_lane",
          "A stage agent in a lane asks its coordinator; use ask_coordinator",
        );
      const { run: first } = requireOpenTurn(caller);
      // Retention deletes only closed chats, so a gone asking chat counts as closed.
      const closed = unlessGone(() => agents.isClosed(first.asking_agent_id)) ?? true;
      const worker = closed ? await agents.activeWorker(caller.workspaceId) : undefined;
      const asked = host.store.transaction(() => {
        // The awaits above may have let the turn close.
        const { run, turn } = requireOpenTurn(caller);
        const askedId = worker?.id ?? run.asking_agent_id;
        if (worker) {
          host.store.run(
            "UPDATE pipelines_runs SET asking_agent_id = ? WHERE id = ?",
            worker.id,
            run.id,
          );
        }
        const id = host.newId();
        host.store.run(
          `INSERT INTO pipelines_questions
             (id, run_id, turn_id, agent_id, asked_agent_id, question, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
          id,
          run.id,
          turn.id,
          caller.agentId,
          askedId,
          request.question,
          host.now(),
        );
        const row = loadQuestion(id) as QuestionRow;
        agents.deliver(askedId, questionMessage(run, turn, titleOf(caller.agentId), row));
        return questionToView(row);
      });
      publish(caller.workspaceId);
      return asked;
    };

    const answerStage = (caller: BridgeCaller, request: AnswerStageRequest): StageQuestion => {
      const question = loadQuestion(request.questionId);
      if (!question)
        throw new ApiError(404, "question_not_found", `No stage question ${request.questionId}`);
      if (question.asked_agent_id !== caller.agentId)
        throw new ApiError(403, "not_asked", `Question ${question.id} was asked of another chat`);
      if (question.state !== "open")
        throw new ApiError(409, "question_answered", `Question ${question.id} has an answer`);
      const run = requireRun(question.run_id);
      const turn = turnById(question.turn_id) as TurnRow;
      if (run.state !== "running" || turn.report !== null || turn.error !== null)
        throw new ApiError(409, "turn_closed", `The turn of question ${question.id} is closed`);
      const answered = host.store.transaction(() => {
        host.store.run(
          "UPDATE pipelines_questions SET answer = ?, state = 'answered', answered_at = ? WHERE id = ?",
          request.answer,
          host.now(),
          question.id,
        );
        agents.deliver(question.agent_id, answerMessage(question, request.answer));
        return questionToView(loadQuestion(question.id) as QuestionRow);
      });
      publish(run.workspace_id);
      return answered;
    };

    approvals.register({
      kind: ROUND_LIMIT,
      subject: RoundLimitSubject,
      // All effects are in `decided`, in the transaction that stores the decision.
      approve: async (subject) =>
        subject.action === "fix"
          ? `The user chose fix: the worker makes one last fix for stage ${subject.stage}, with no review after it; then the run goes on.`
          : `The user chose accept: the run goes on after stage ${subject.stage} without a fix for its findings.`,
      decided: (subject: RoundLimitSubject, approval, approved) => {
        const run = loadRun(subject.runId);
        // A run that was stopped or moved on ignores the decision.
        if (run?.state !== "waiting_user" || run.approval_id !== approval.id) return;
        if (approved) {
          // Fix keeps every REVISE of the round; accept drops the members at their limit. Red gates go into the fix
          // either way (ADR 0178 rule 7).
          const group = groupOf(run, run.stage_index);
          const turns = groupTurns(run, group);
          const round = reviewRound(turns);
          const reds = redsOf(run);
          const members = group.filter((index) => {
            const review = liveTurn(turns, "review", round, index);
            if (review === undefined) return isRed(reds, round, stageOf(run, index).name);
            return (
              reportOf(review).verdict === "revise" &&
              (subject.action === "fix" || !atLimit(stageOf(run, index), round))
            );
          });
          // The fix turn is open when the job wakes; `decide` sends it to `await`. With nothing to fix, the kept
          // approval id makes `decide` end the group.
          if (members.length > 0) {
            const last = openMembers(run, group, turns, round + 1).length === 0;
            startFix(run, group[0] as number, round, members, last);
          }
          host.store.run(
            "UPDATE pipelines_runs SET state = 'running', message = NULL, approval_id = ? WHERE id = ?",
            members.length > 0 ? null : run.approval_id,
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

    const requireModel = async (model: string, callerAgentId?: string): Promise<void> => {
      if (model === ROUTE_MODEL) return;
      const available = await agents.availableModels(callerAgentId);
      if (available.some((found) => `${found.provider}/${found.id}` === model)) return;
      const id = model.slice(model.indexOf("/") + 1);
      const same = available
        .filter((found) => found.id === id)
        .map((found) => `${found.provider}/${found.id}`);
      throw new ApiError(
        400,
        "unknown_model",
        `Pi cannot run ${model}: it is not in Pi's model list (no auth or unknown).${same.length > 0 ? ` Available with id ${id}: ${same.join(", ")}.` : ""}`,
      );
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
      if (request.workerModel !== undefined)
        await requireModel(request.workerModel, request.askingAgentId);
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
      askStage,
      answerStage,
      start,
      requireModel,
      get: (runId) => viewOf(requireRun(runId)),
      runsOf,
      stop,
      afterRunEnded: (listener) => {
        endListeners.push(listener);
      },
      onChange: (listener) => {
        changeListeners.push(listener);
      },
      refreshWorking: syncWorking,
      laneQuestionChanged: publish,
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

    /**
     * Runs the waiting stage job's step now: the way to continue after the user fixed what blocked it. A stray wake may
     * be running a blocked job's step again, with its error kept; the run shows `blocked` then too, so both take it.
     * `column` says what happens to a failed open turn: `retry_error` asks its agent to continue, `error` gives the
     * turn to a fresh agent.
     */
    const retryRun = async (runId: string, column: "retry_error" | "error") => {
      const run = requireRun(runId);
      const job = host.jobs
        .list({ kind: STAGE_JOB, key: run.workspace_id, states: ["running", "waiting"] })
        .find(
          (found) =>
            (found.subject as StageSubject).runId === run.id &&
            (found.state === "waiting" || found.error !== null),
        );
      if (!job) throw new ApiError(409, "run_not_waiting", "The run has no waiting job to retry");
      // A restart or a stray wake re-runs `await` without this mark, so the turn only blocks again. Only Retry and
      // Fresh agent act on a failed turn. They mark the open turns `await` blocks on: a failed agent, or one reminded
      // that ended again. Retry keeps the raw failure for the continue message; Fresh agent keeps the block message.
      if (job.step === "await" && job.error !== null) {
        const failed: { id: string; failure: string }[] = [];
        for (const turn of turnRows(run.id)) {
          if (turn.error !== null || turn.report !== null) continue;
          const failure = await agents.turnError(turn.agent_id);
          if (failure !== undefined) failed.push({ id: turn.id, failure: failure.error });
          else if (turn.reminded === 1 && (await agents.endedRun(turn.agent_id))) {
            failed.push({ id: turn.id, failure: "you ended your turn twice without a report" });
          }
        }
        host.store.transaction(() => {
          for (const { id, failure } of failed) {
            host.store.run(
              `UPDATE pipelines_turns SET ${column} = ? WHERE id = ? AND report IS NULL`,
              column === "error" ? job.error : failure,
              id,
            );
          }
        });
      }
      // `retry` runs a waiting job. A report during the reads above may have started the step again, and `retry` skips
      // a running job, so the wake covers it: a wake during a running step applies when it settles, and a step that
      // read the turn before the mark runs again. Each call does nothing in the other case.
      host.jobs.retry(job.id);
      host.jobs.wake(STAGE_JOB, run.workspace_id);
      publish(run.workspace_id);
      return viewOf(requireRun(run.id));
    };

    // Retry: the failed turn's agent continues it (the turn stays open and counts one attempt more).
    host.routes.post("/runs/:id/retry", async (c) =>
      c.json({ run: await retryRun(c.req.param("id"), "retry_error") }),
    );

    // Fresh agent: the failed turn gets `error`, and a fresh agent of its role takes it over (ADR 0140).
    host.routes.post("/runs/:id/fresh", async (c) =>
      c.json({ run: await retryRun(c.req.param("id"), "error") }),
    );

    // The user steps away (ADR 0187). The open turn goes on; the stage job starts nothing until Resume.
    host.routes.post("/runs/:id/pause", (c) => {
      const run = requireRun(c.req.param("id"));
      if (run.state !== "running") {
        throw new ApiError(
          409,
          "run_not_running",
          `The run is ${run.state}; only a running run pauses`,
        );
      }
      host.store.run(
        "UPDATE pipelines_runs SET paused_at = ? WHERE id = ? AND paused_at IS NULL",
        host.now(),
        run.id,
      );
      publish(run.workspace_id);
      return c.json({ run: viewOf(requireRun(run.id)) });
    });

    host.routes.post("/runs/:id/resume", (c) => {
      const run = requireRun(c.req.param("id"));
      if (run.state !== "running" || run.paused_at === null) {
        throw new ApiError(409, "run_not_paused", "The run is not paused");
      }
      host.store.run("UPDATE pipelines_runs SET paused_at = NULL WHERE id = ?", run.id);
      host.jobs.wake(STAGE_JOB, run.workspace_id);
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
