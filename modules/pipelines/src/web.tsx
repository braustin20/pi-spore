import {
  type ApprovalViewProps,
  type AttentionWeb,
  AttentionWebKey,
} from "@pi-spore/mod-attention/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  PipelineEvent,
  PipelineList,
  type PipelineRun,
  type PipelineRunState,
  type PipelineView,
  parse,
  type Workspace,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  CollapsibleSection,
  EmptyState,
  Field,
  Input,
  Notice,
  SectionLabel,
  Select,
  Spinner,
  Textarea,
  type Tone,
} from "@pi-spore/ui";
import { ChevronRight, Workflow } from "lucide-react";
import { type SubmitEvent, useEffect, useState } from "react";
import { splitRunMessage } from "./gate-log.js";
import { formatDuration, isActive, StepBar, Timeline } from "./timeline.js";
import { openFindings, SEVERITIES } from "./turns.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATES: Record<PipelineRunState, { text: string; tone: Tone }> = {
  running: { text: "Running", tone: "run" },
  waiting_user: { text: "Waiting for you", tone: "warn" },
  passed: { text: "Passed", tone: "ok" },
  failed: { text: "Failed", tone: "fail" },
  stopped: { text: "Stopped", tone: "neutral" },
};

/** The workspace's runs, newest first: the topic sends the snapshot, then every change. */
function useRuns(workspaceId: string): PipelineRun[] | undefined {
  const api = useApi();
  const [runs, setRuns] = useState<PipelineRun[] | undefined>();
  useEffect(
    () =>
      api.subscribe(`pipelines:${workspaceId}`, (raw) =>
        setRuns(parse(PipelineEvent, raw, "pipeline event").runs),
      ),
    [api, workspaceId],
  );
  return runs;
}

function StartForm({ workspace }: { workspace: Workspace }) {
  const api = useApi();
  const [pipelines, setPipelines] = useState<PipelineView[] | undefined>();
  const [pipeline, setPipeline] = useState("");
  const [brief, setBrief] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get(`pipelines/workspaces/${workspace.id}`)
      .then((raw) => {
        const found = parse(PipelineList, raw, "pipeline list").pipelines;
        setPipelines(found);
        setPipeline(found.find((entry) => !entry.error)?.id ?? "");
      })
      .catch((caught) => setError(message(caught)));
  }, [api, workspace.id]);

  const start = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.send("POST", `pipelines/workspaces/${workspace.id}/runs`, {
        pipeline,
        brief,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
    } catch (caught) {
      setError(message(caught));
    }
    setBusy(false);
  };

  const broken = pipelines?.filter((entry) => entry.error) ?? [];
  return (
    <form onSubmit={(event) => void start(event)} className="flex flex-col gap-3 p-4">
      <SectionLabel>Start a pipeline</SectionLabel>
      {error && <Notice tone="fail">{error}</Notice>}
      {pipelines?.length === 0 && <Notice>No pipelines found for this project.</Notice>}
      <Field label="Pipeline">
        <Select value={pipeline} onChange={(event) => setPipeline(event.target.value)}>
          {pipelines?.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={Boolean(entry.error)}>
              {entry.id} ({entry.source}){entry.error ? ", has an error" : ""}
            </option>
          ))}
        </Select>
      </Field>
      {broken.map((entry) => (
        <Notice key={entry.id} tone="warn">
          <code>{entry.id}</code> cannot start: {entry.error}
        </Notice>
      ))}
      <Field label="Name">
        <Input
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Short name of this slice"
        />
      </Field>
      <Field label="Brief">
        <Textarea
          rows={8}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="What the worker should build. Say how to tell it is done."
        />
      </Field>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || pipeline === "" || brief.trim() === ""}
        >
          {busy && <Spinner />}
          Start
        </Button>
      </div>
    </form>
  );
}

/** From the first turn to the end of the run, or to now while it is active. */
function elapsed(run: PipelineRun, now: number): string {
  const start =
    run.turns.length > 0 ? Math.min(...run.turns.map((turn) => turn.createdAt)) : run.createdAt;
  const reported = run.turns.flatMap((turn) =>
    turn.reportedAt === undefined ? [] : [turn.reportedAt],
  );
  const end = isActive(run)
    ? now
    : (run.endedAt ?? (reported.length > 0 ? Math.max(...reported) : start));
  return formatDuration(end - start);
}

function RunCard({
  run,
  workspaceId,
  now,
  defaultOpen,
}: {
  run: PipelineRun;
  workspaceId: string;
  now: number;
  defaultOpen: boolean;
}) {
  const api = useApi();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  // A step click on a closed card opens it; the row exists only after that render.
  const [pendingStep, setPendingStep] = useState<number | undefined>();
  const shown = STATES[run.state];

  useEffect(() => {
    if (pendingStep === undefined) return;
    document
      .getElementById(`step-${run.id}-${pendingStep}`)
      ?.scrollIntoView?.({ block: "nearest" });
    setPendingStep(undefined);
  }, [pendingStep, run.id]);

  const act = async (action: "retry" | "cancel") => {
    setBusy(true);
    setError(undefined);
    try {
      await api.send("POST", `pipelines/runs/${run.id}/${action}`);
    } catch (caught) {
      setError(message(caught));
    }
    setBusy(false);
  };

  // A failed gate's log sits in the timeline's Gates row; the notice keeps the headline and the failed tests.
  const notice = run.message && splitRunMessage(run.message).notice;

  return (
    <section
      aria-label={`Run of ${run.pipelineId}`}
      className="flex flex-col gap-2 rounded-xl border border-line bg-raised/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex cursor-pointer items-center gap-1.5 font-medium"
        >
          <ChevronRight
            aria-hidden="true"
            className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          {run.name ?? run.pipelineId}
        </button>
        {run.name && <Chip>{run.pipelineId}</Chip>}
        <Chip>{run.source}</Chip>
        <Chip tone={shown.tone}>{shown.text}</Chip>
        <span className="text-xs text-muted">{elapsed(run, now)}</span>
        <span className="flex-1" />
        {isActive(run) && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel")}>
            Cancel
          </Button>
        )}
      </div>
      <StepBar
        run={run}
        onStep={(index) => {
          setOpen(true);
          setPendingStep(index);
        }}
      />
      {open && run.state === "waiting_user" && (
        <Notice tone="warn">The decision is on Home. {run.message}</Notice>
      )}
      {open && run.state !== "waiting_user" && notice && (
        <Notice tone={run.state === "failed" ? "fail" : "info"}>
          <span className="whitespace-pre-wrap">{notice}</span>
        </Notice>
      )}
      {open && run.blocked && (
        <Notice tone="warn">
          <p className="m-0">The run is stuck: {run.blocked}</p>
          <Button size="sm" className="mt-2" disabled={busy} onClick={() => void act("retry")}>
            Retry
          </Button>
        </Notice>
      )}
      {error && <Notice tone="fail">{error}</Notice>}
      {open && <Timeline run={run} workspaceId={workspaceId} now={now} />}
    </section>
  );
}

/** The Pipeline tab (R6.7): start a run, then watch its steps and turns. */
function PipelineTab({ workspace }: { workspace: Workspace }) {
  const runs = useRuns(workspace.id);
  const [now, setNow] = useState(() => Date.now());
  const anyActive = runs?.some(isActive) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [anyActive]);
  if (!runs) {
    return (
      <div className="p-4">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!anyActive && <StartForm key={workspace.id} workspace={workspace} />}
      {runs.length === 0 ? (
        <EmptyState icon={Workflow} title="No runs yet">
          Start a pipeline above.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {runs.map((run, index) => (
            <RunCard
              key={run.id}
              run={run}
              workspaceId={workspace.id}
              now={now}
              defaultOpen={index === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A short line in the Details tab: the latest run's state and stage, and what its latest review found. */
function PipelinePanel({ workspace }: { workspace: Workspace }) {
  const run = useRuns(workspace.id)?.[0];
  if (!run) return null;
  const shown = STATES[run.state];
  const counts = openFindings(run);
  return (
    <CollapsibleSection title="Pipeline">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span>{run.pipelineId}</span>
        <Chip tone={shown.tone}>{shown.text}</Chip>
        <Chip mono>stage {run.stages[run.stageIndex]?.name}</Chip>
        {run.blocked && <Chip tone="warn">Stuck</Chip>}
      </div>
      {counts && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {SEVERITIES.map(({ severity, title, tone }) => (
            <Chip key={severity} tone={counts[severity] > 0 ? tone : "neutral"}>
              {title} · {counts[severity]}
            </Chip>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

let DeclineNote: AttentionWeb["DeclineNote"] | undefined;

/** A `pipeline-round-limit` approval on Home: the three choices at a review stage's round limit. */
function RoundLimitView({ approval, busy, approve, decline }: ApprovalViewProps) {
  const [note, setNote] = useState("");
  const Note = DeclineNote as AttentionWeb["DeclineNote"];
  // The server checks the subject again on approve; only `action` changes here.
  const subject = approval.subject as object;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-sm font-medium">{approval.title}</p>
      <p className="m-0 text-sm whitespace-pre-wrap">{approval.reason}</p>
      <Note note={note} onChange={setNote} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => approve({ ...subject, action: "fix" })}
        >
          Fix the findings, then go on
        </Button>
        <Button disabled={busy} onClick={() => approve({ ...subject, action: "accept" })}>
          Go on without a fix
        </Button>
        <Button disabled={busy} onClick={() => decline(note.trim() || undefined)}>
          Stop the run
        </Button>
      </div>
    </div>
  );
}

export const pipelinesWeb: WebModule = {
  id: "pipelines",
  requires: ["workspaces", "attention"],
  core: false,
  setup(host) {
    const attention = host.use(AttentionWebKey);
    DeclineNote = attention.DeclineNote;
    attention.addApprovalView("pipeline-round-limit", RoundLimitView);
    const view = host.use(WorkspaceViewKey);
    view.addTab({ id: "pipeline", title: "Pipeline", order: 6, component: PipelineTab });
    view.addPanel({ id: "pipeline", order: 6, component: PipelinePanel });
  },
};
