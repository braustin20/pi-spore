import { type PipelineRun, type PipelineTurn, stageGroups, stripAnsi } from "@pi-spore/shared";
import { Chip, CollapsibleSection, Spinner } from "@pi-spore/ui";
import {
  Check,
  ChevronRight,
  Circle,
  Hourglass,
  Pause,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { GateLog, splitRunMessage } from "./gate-log.js";
import { EarlyStopLine, FindingItems, routeText, SEVERITIES, TestList } from "./turns.js";

type StepState =
  | "done"
  | "running"
  | "paused"
  | "blocked"
  | "waiting"
  | "waiting for the fix"
  | "failed"
  | "stopped"
  | "not started";

const STEP_ICONS: Record<StepState, ReactNode> = {
  done: <Check aria-hidden="true" className="size-3.5 text-ok" />,
  running: <Spinner />,
  // Muted: the user paused the run on purpose (ADR 0187).
  paused: <Pause aria-hidden="true" className="size-3.5 text-muted" />,
  blocked: <TriangleAlert aria-hidden="true" className="size-3.5 text-warn" />,
  waiting: <Hourglass aria-hidden="true" className="size-3.5 text-warn" />,
  // Muted, not warn: the user has nothing to do while the worker fixes.
  "waiting for the fix": <Hourglass aria-hidden="true" className="size-3.5 text-muted" />,
  failed: <X aria-hidden="true" className="size-3.5 text-fail" />,
  stopped: <Square aria-hidden="true" className="size-3.5 text-muted" />,
  "not started": <Circle aria-hidden="true" className="size-3.5 text-muted" />,
};

/** The position of the group that holds a stage (ADR 0178): members of one group share it. */
const groupAt = (groups: number[][], index: number) =>
  groups.findIndex((group) => group.includes(index));

/** The stage a turn's work belongs to: a fix turn carries the review stage's index, but its work is the
 * worker's. */
function stageOf(run: PipelineRun, turn: PipelineTurn): number {
  const workerStage = run.stages.findIndex((stage) => stage.role === "worker");
  return turn.kind === "fix" && workerStage >= 0 ? workerStage : turn.stageIndex;
}

/** The fix turn that runs now, if any. A blocked or waiting run keeps its own look. */
const runningFix = (run: PipelineRun) =>
  run.state === "running" && !run.blocked
    ? run.turns.find((turn) => turn.kind === "fix" && isRunning(run, turn))
    : undefined;

function stepState(run: PipelineRun, index: number): StepState {
  if (run.state === "passed") return "done";
  // A group runs as one stage, and `run.stageIndex` is its first member, so compare groups.
  const groups = stageGroups(run.stages);
  const current = groupAt(groups, run.stageIndex);
  const own = groupAt(groups, index);
  // During a fix the worker runs, and the reviewers of the current group wait for it (R6, ADR 0158).
  const fix = runningFix(run);
  if (fix && index === stageOf(run, fix)) return run.paused ? "paused" : "running";
  if (fix && own === current) return "waiting for the fix";
  if (own < current) return "done";
  if (own > current) return "not started";
  // A member that reported while the rest of its group still works is done. A stage alone keeps today's state.
  const live = run.turns.filter(
    (turn) => turn.stageIndex === index && turn.kind === "review" && !turn.error,
  );
  const reported = live.length > 0 && live.every((turn) => turn.reportedAt !== undefined);
  if ((groups[own]?.length ?? 0) > 1 && isActive(run) && reported) return "done";
  if (run.state === "failed") return "failed";
  if (run.state === "stopped") return "stopped";
  if (run.blocked) return "blocked";
  if (run.paused) return "paused";
  return run.state === "waiting_user" ? "waiting" : "running";
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The extra words on a step: how many review rounds ran, or how many fixes the worker made. */
function stepCount(run: PipelineRun, index: number): string | undefined {
  const stage = run.stages[index];
  if (stage?.role === "worker") {
    // Fix turns carry the review stage's index, so they are counted by kind. A running fix is not done yet.
    const fixes = run.turns.filter(
      (turn) => turn.kind === "fix" && turn.reportedAt !== undefined,
    ).length;
    if (runningFix(run)) return fixes === 0 ? "fixing" : `fix ${fixes + 1}`;
    return fixes > 0 ? plural(fixes, "fix", "fixes") : undefined;
  }
  const rounds = Math.max(
    0,
    ...run.turns
      .filter((turn) => turn.stageIndex === index && turn.kind === "review")
      .map((turn) => turn.round),
  );
  return rounds >= 2 ? `${rounds} rounds` : undefined;
}

/** One step per group, with arrows between them. A parallel group's members sit side by side in one box
 * (ADR 0178 rule 27). */
export function StepBar({
  run,
  onStep,
}: {
  run: PipelineRun;
  onStep: (stageIndex: number) => void;
}) {
  const step = (index: number, shape: string) => {
    // SAFETY: a group lists indexes of the run's own stages.
    const stage = run.stages[index] as PipelineRun["stages"][number];
    const state = stepState(run, index);
    const count = stepCount(run, index);
    return (
      <button
        key={stage.name}
        type="button"
        aria-label={`${stage.name}: ${state}`}
        onClick={() => onStep(index)}
        className={`flex cursor-pointer items-center gap-1.5 ${shape} px-2 py-1 text-xs hover:bg-raised`}
      >
        {STEP_ICONS[state]}
        {count ? `${stage.name} · ${count}` : stage.name}
      </button>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {stageGroups(run.stages).map((group, position) => (
        <Fragment key={group[0]}>
          {position > 0 && <ChevronRight aria-hidden="true" className="size-3.5 text-muted" />}
          {group.length === 1 ? (
            step(group[0] as number, "rounded-md border border-line")
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset's border and min-width stop the wrap on a phone
            <div
              role="group"
              aria-label={`parallel: ${group.map((index) => run.stages[index]?.name).join(", ")}`}
              className="flex flex-wrap items-center gap-1 rounded-md border border-line p-0.5"
            >
              {group.map((index) => step(index, "rounded"))}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

type Entry =
  | { key: string; stageIndex: number; turn: PipelineTurn }
  | { key: string; stageIndex: number; gates: readonly string[] };

/** All turns by time, with a Gates entry where each started gate stage comes in the run. */
function entriesOf(run: PipelineRun): Entry[] {
  // A gate member starts with its group, and `run.stageIndex` is the group's first stage (ADR 0178 rule 22).
  const groups = stageGroups(run.stages);
  const started = (index: number) =>
    run.state === "passed" || groupAt(groups, index) <= groupAt(groups, run.stageIndex);
  const pending = run.stages.flatMap((stage, index) =>
    stage.gates && started(index) ? [{ index, gates: stage.gates }] : [],
  );
  const entries: Entry[] = [];
  const flush = (before: number) => {
    while (pending[0] && pending[0].index < before) {
      const { index, gates } = pending.shift() as (typeof pending)[number];
      entries.push({ key: `gates-${index}`, stageIndex: index, gates });
    }
  };
  // `toSorted` is stable and leaves the run's own array alone.
  for (const turn of run.turns.toSorted((a, b) => a.createdAt - b.createdAt)) {
    flush(turn.stageIndex);
    entries.push({ key: turn.id, stageIndex: stageOf(run, turn), turn });
  }
  flush(Number.POSITIVE_INFINITY);
  return entries;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

export const isActive = (run: PipelineRun) =>
  run.state === "running" || run.state === "waiting_user";

/** A turn of an ended run that never reported is not running any more. */
const isRunning = (run: PipelineRun, turn: PipelineTurn) =>
  isActive(run) && turn.reportedAt === undefined && !turn.error;

const kindLabel = (turn: PipelineTurn) =>
  turn.kind === "task"
    ? "Task"
    : turn.kind === "review"
      ? `Review, round ${turn.round}`
      : `Fix for ${(turn.fixFor ?? [turn.stage]).join(", ")} round ${turn.round}`;

function Counts({ turn }: { turn: PipelineTurn }) {
  const text = SEVERITIES.flatMap(({ severity }) => {
    const count = (turn.report?.findings ?? []).filter((f) => f.severity === severity).length;
    return count > 0 ? [`${count} ${severity}`] : [];
  }).join(" · ");
  return text ? <span className="text-xs text-muted">{text}</span> : null;
}

function TurnHead({ turn, running, now }: { turn: PipelineTurn; running: boolean; now: number }) {
  const verdict = turn.report?.verdict;
  const duration =
    turn.reportedAt !== undefined
      ? formatDuration(turn.reportedAt - turn.createdAt)
      : running
        ? `running ${formatDuration(now - turn.createdAt)}`
        : undefined;
  return (
    <>
      <span className="text-xs text-muted">{kindLabel(turn)}</span>
      {verdict && (
        <Chip tone={verdict === "approve" ? "ok" : "warn"}>
          {verdict === "approve" ? "Approve" : "Revise"}
        </Chip>
      )}
      <Counts turn={turn} />
      {turn.model && <Chip mono>{turn.model}</Chip>}
      {duration && <span className="text-xs text-muted">{duration}</span>}
      {turn.error && <Chip tone="fail">Failed</Chip>}
    </>
  );
}

function TurnBody({ turn, workspaceId }: { turn: PipelineTurn; workspaceId: string }) {
  const { report } = turn;
  const findings = report?.findings ?? [];
  const minor = findings.filter((finding) => finding.severity === "minor");
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 text-sm">
      {report && <p className="m-0 whitespace-pre-wrap">{report.summary}</p>}
      {SEVERITIES.map(({ severity, title, tone }) => {
        const found = findings.filter((finding) => finding.severity === severity);
        if (severity === "minor" || found.length === 0) return null;
        return (
          <div key={severity}>
            <Chip tone={tone}>
              {title} · {found.length}
            </Chip>
            <FindingItems findings={found} />
          </div>
        );
      })}
      {minor.length > 0 && (
        <CollapsibleSection title={`${minor.length} minor`} defaultOpen={false}>
          <FindingItems findings={minor} />
        </CollapsibleSection>
      )}
      {report?.tests && report.tests.length > 0 && (
        <CollapsibleSection
          title={plural(report.tests.length, "test", "tests")}
          defaultOpen={false}
        >
          <TestList tests={report.tests} />
        </CollapsibleSection>
      )}
      {turn.routing && (
        <CollapsibleSection title="Route" defaultOpen={false}>
          <p className="m-0 text-xs text-muted">{routeText(turn.routing)}</p>
        </CollapsibleSection>
      )}
      {report?.earlyStop && <EarlyStopLine earlyStop={report.earlyStop} />}
      {turn.modelNote && <p className="m-0 whitespace-pre-wrap text-muted">{turn.modelNote}</p>}
      {turn.error && <p className="m-0 whitespace-pre-wrap text-muted">{turn.error}</p>}
      {!report && !turn.error && turn.question && (
        <>
          <p className="m-0 text-muted">
            Waiting for an answer from{" "}
            <a
              href={`#/workspaces/${turn.question.askedWorkspaceId}/chats/${turn.question.askedAgentId}`}
              className="text-accent-strong"
            >
              {turn.question.askedTitle}
            </a>
            .
          </p>
          <p className="m-0 whitespace-pre-wrap">{turn.question.question}</p>
        </>
      )}
      {!report && !turn.error && !turn.question && (
        <p className="m-0 text-muted">Waiting for the report.</p>
      )}
      <a
        href={`#/workspaces/${workspaceId}/chats/${turn.agentId}`}
        className="text-xs text-accent-strong"
      >
        Open chat
      </a>
    </div>
  );
}

function GatesBody({ run, state }: { run: PipelineRun; state: StepState }) {
  if (state === "failed") {
    return (
      <div className="mt-1.5">
        {/* Runs from before the log heading carry the whole log in the message, maybe with color codes. */}
        <GateLog text={stripAnsi(splitRunMessage(run.message ?? "").log ?? run.message ?? "")} />
      </div>
    );
  }
  return (
    <p className="m-0 mt-1.5 text-sm text-muted">
      {state === "done" ? "The gates passed." : "The gates have not finished."}
    </p>
  );
}

/** Every turn of a run in one list by time, numbered from 1. A row opens on click. */
export function Timeline({
  run,
  workspaceId,
  now,
}: {
  run: PipelineRun;
  workspaceId: string;
  now: number;
}) {
  // The user's choices only. A row with no choice follows the default, so new data cannot close a row.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const entries = entriesOf(run);
  const isLive = (entry: Entry) =>
    "turn" in entry
      ? isRunning(run, entry.turn)
      : // A gate member is live while its group runs; `run.stageIndex` is the group's first stage.
        isActive(run) &&
        groupAt(stageGroups(run.stages), entry.stageIndex) ===
          groupAt(stageGroups(run.stages), run.stageIndex);
  const defaultKey = (entries.findLast(isLive) ?? entries.at(-1))?.key;
  const seen = new Set<number>();

  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {entries.map((entry, position) => {
        const first = !seen.has(entry.stageIndex);
        seen.add(entry.stageIndex);
        const open = chosen[entry.key] ?? entry.key === defaultKey;
        const stageName = run.stages[entry.stageIndex]?.name;
        const gatesState = "gates" in entry ? stepState(run, entry.stageIndex) : undefined;
        return (
          <li
            key={entry.key}
            id={first ? `step-${run.id}-${entry.stageIndex}` : undefined}
            className="border-t border-line py-2 first:border-t-0"
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setChosen((before) => ({ ...before, [entry.key]: !open }))}
              className="flex w-full cursor-pointer flex-wrap items-center gap-1.5 text-left"
            >
              <ChevronRight
                aria-hidden="true"
                className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span className="font-mono text-xs text-muted">{position + 1}</span>
              {"turn" in entry ? (
                <>
                  <span className="text-sm font-medium">{stageName ?? entry.turn.stage}</span>
                  <TurnHead turn={entry.turn} running={isLive(entry)} now={now} />
                </>
              ) : (
                <>
                  {gatesState && STEP_ICONS[gatesState]}
                  <span className="text-sm font-medium">Gates: {entry.gates.join(", ")}</span>
                </>
              )}
            </button>
            {/* The open row shows the full summary, so the headline is only for a closed row. */}
            {!open && "turn" in entry && entry.turn.report && (
              <p className="m-0 truncate pl-5 text-xs text-muted">
                {entry.turn.report.summary.split("\n", 1)[0]}
              </p>
            )}
            {open &&
              ("turn" in entry ? (
                <TurnBody turn={entry.turn} workspaceId={workspaceId} />
              ) : (
                gatesState && <GatesBody run={run} state={gatesState} />
              ))}
          </li>
        );
      })}
    </ol>
  );
}
