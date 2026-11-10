import type { PipelineRun, PipelineTurn } from "@pi-spore/shared";
import { Chip, CollapsibleSection, Spinner } from "@pi-spore/ui";
import { Check, ChevronRight, Circle, Hourglass, Square, TriangleAlert, X } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { EarlyStopLine, FindingItems, routeText, SEVERITIES, TestList } from "./turns.js";

type StepState = "done" | "running" | "blocked" | "waiting" | "failed" | "stopped" | "not started";

const STEP_ICONS: Record<StepState, ReactNode> = {
  done: <Check aria-hidden="true" className="size-3.5 text-ok" />,
  running: <Spinner />,
  blocked: <TriangleAlert aria-hidden="true" className="size-3.5 text-warn" />,
  waiting: <Hourglass aria-hidden="true" className="size-3.5 text-warn" />,
  failed: <X aria-hidden="true" className="size-3.5 text-fail" />,
  stopped: <Square aria-hidden="true" className="size-3.5 text-muted" />,
  "not started": <Circle aria-hidden="true" className="size-3.5 text-muted" />,
};

function stepState(run: PipelineRun, index: number): StepState {
  if (run.state === "passed" || index < run.stageIndex) return "done";
  if (index > run.stageIndex) return "not started";
  if (run.state === "failed") return "failed";
  if (run.state === "stopped") return "stopped";
  if (run.blocked) return "blocked";
  return run.state === "waiting_user" ? "waiting" : "running";
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The extra words on a step: how many review rounds ran, or how many fixes the worker made. */
function stepCount(run: PipelineRun, index: number): string | undefined {
  const stage = run.stages[index];
  if (stage?.role === "worker") {
    // Fix turns carry the review stage's index, so they are counted by kind.
    const fixes = run.turns.filter((turn) => turn.kind === "fix").length;
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

/** One button per stage with its state, and arrows between them. */
export function StepBar({
  run,
  onStep,
}: {
  run: PipelineRun;
  onStep: (stageIndex: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {run.stages.map((stage, index) => {
        const state = stepState(run, index);
        const count = stepCount(run, index);
        return (
          <Fragment key={stage.name}>
            {index > 0 && <ChevronRight aria-hidden="true" className="size-3.5 text-muted" />}
            <button
              type="button"
              aria-label={`${stage.name}: ${state}`}
              onClick={() => onStep(index)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs hover:bg-raised"
            >
              {STEP_ICONS[state]}
              {count ? `${stage.name} · ${count}` : stage.name}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

type Entry =
  | { key: string; stageIndex: number; turn: PipelineTurn }
  | { key: string; stageIndex: number; gates: readonly string[] };

/** All turns by time, with a Gates entry where each started gate stage comes in the run. */
function entriesOf(run: PipelineRun): Entry[] {
  const workerStage = run.stages.findIndex((stage) => stage.role === "worker");
  const started = (index: number) => run.state === "passed" || index <= run.stageIndex;
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
    // A fix turn carries the review stage's index; its work is the worker's.
    const stageIndex = turn.kind === "fix" && workerStage >= 0 ? workerStage : turn.stageIndex;
    entries.push({ key: turn.id, stageIndex, turn });
  }
  flush(Number.POSITIVE_INFINITY);
  return entries;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

const isActive = (run: PipelineRun) => run.state === "running" || run.state === "waiting_user";

/** A turn of an ended run that never reported is not running any more. */
const isRunning = (run: PipelineRun, turn: PipelineTurn) =>
  isActive(run) && turn.reportedAt === undefined && !turn.error;

const kindLabel = (turn: PipelineTurn) =>
  turn.kind === "task"
    ? "Task"
    : turn.kind === "review"
      ? `Review, round ${turn.round}`
      : `Fix for ${turn.stage} round ${turn.round}`;

/** Color codes in a gate log are noise in a page. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what this matches
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

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
      {turn.routing?.model && <Chip mono>{turn.routing.model}</Chip>}
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
      {!report && !turn.error && <p className="m-0 text-muted">Waiting for the report.</p>}
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
      <pre className="m-0 mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap text-xs">
        {(run.message ?? "").replace(ANSI, "")}
      </pre>
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
      : isActive(run) && entry.stageIndex === run.stageIndex;
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
