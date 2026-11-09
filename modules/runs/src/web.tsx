import {
  type ApprovalViewProps,
  type AttentionWeb,
  AttentionWebKey,
} from "@pi-spore/mod-attention/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  type Lane,
  type LaneState,
  type Project,
  ProjectList,
  parse,
  Run,
  RunEvent,
  RunPrSubject,
  type RunState,
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
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SectionLabel,
  Select,
  Spinner,
  Textarea,
  type Tone,
} from "@pi-spore/ui";
import { Network } from "lucide-react";
import { type SubmitEvent, useEffect, useState } from "react";
import Type from "typebox";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATES: Record<LaneState, { text: string; tone: Tone }> = {
  approval: { text: "Needs your approval", tone: "warn" },
  waiting: { text: "Waiting for its wave", tone: "neutral" },
  starting: { text: "Starting", tone: "run" },
  running: { text: "Running", tone: "run" },
  passed: { text: "Passed", tone: "ok" },
  failed: { text: "Failed", tone: "fail" },
  declined: { text: "Declined", tone: "neutral" },
  merging: { text: "Merging", tone: "run" },
  merged: { text: "Merged", tone: "ok" },
  cancelled: { text: "Cancelled", tone: "neutral" },
};

const RUN_STATES: Record<RunState, { text: string; tone: Tone }> = {
  running: { text: "Running", tone: "run" },
  cancelled: { text: "Cancelled", tone: "neutral" },
  finished: { text: "PR opened", tone: "ok" },
};

const RunBody = Type.Object({ run: Run });

/** Every run, newest first: the topic sends the snapshot, then every change. */
function useRuns(): Run[] | undefined {
  const api = useApi();
  const [runs, setRuns] = useState<Run[] | undefined>();
  useEffect(
    () => api.subscribe("runs:list", (raw) => setRuns(parse(RunEvent, raw, "run event").runs)),
    [api],
  );
  return runs;
}

/** The lanes of a run, one group per wave, lowest wave first. */
function byWave(lanes: readonly Lane[]): [number, Lane[]][] {
  const waves = new Map<number, Lane[]>();
  for (const lane of lanes) waves.set(lane.wave, [...(waves.get(lane.wave) ?? []), lane]);
  return [...waves].sort(([a], [b]) => a - b);
}

function LaneRow({ lane }: { lane: Lane }) {
  const api = useApi();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const shown = STATES[lane.state];
  const retry = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.send("POST", `pipelines/runs/${lane.pipelineRunId}/retry`);
    } catch (caught) {
      setError(message(caught));
    }
    setBusy(false);
  };
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {lane.workspaceId ? (
          <a href={`#/workspaces/${lane.workspaceId}`} className="font-medium">
            {lane.name}
          </a>
        ) : (
          <span className="font-medium">{lane.name}</span>
        )}
        <Chip tone={shown.tone}>{shown.text}</Chip>
        {lane.blocked && <Chip tone="warn">Blocked</Chip>}
        {lane.model && <Chip mono>{lane.model}</Chip>}
      </div>
      {lane.message && (
        <p className="m-0 text-xs text-muted [overflow-wrap:anywhere]">{lane.message}</p>
      )}
      {lane.blocked && (
        <Notice tone="warn">
          <p className="m-0 [overflow-wrap:anywhere]">{lane.blocked}</p>
          <Button size="sm" className="mt-2" disabled={busy} onClick={() => void retry()}>
            Retry
          </Button>
        </Notice>
      )}
      {error && <Notice tone="fail">{error}</Notice>}
    </li>
  );
}

function CancelRun({ run }: { run: Run }) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.send("POST", `runs/${run.id}/cancel`, {});
      setConfirming(false);
    } catch (caught) {
      setError(message(caught));
    }
    setBusy(false);
  };

  return (
    <>
      {error && <Notice tone="fail">{error}</Notice>}
      {confirming ? (
        <Notice tone="warn">
          <p>
            Cancel run {run.line}? The coordinator chat, every lane's pipeline and agents, and a
            merge in progress stop. Unmerged lanes become cancelled. Nothing is deleted: workspaces,
            branches, and artifacts stay.
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void cancel()}>
              {busy && <Spinner />}
              Cancel run
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Keep running
            </Button>
          </div>
        </Notice>
      ) : (
        <div>
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}

function RunCard({ run }: { run: Run }) {
  const shown = RUN_STATES[run.state];
  return (
    <section
      aria-label={`Run ${run.line}`}
      className="flex flex-col gap-2 rounded-xl border border-line bg-raised/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <a href={`#/workspaces/${run.workspaceId}`} className="font-medium">
          {run.line}
        </a>
        <Chip tone={shown.tone}>{shown.text}</Chip>
        <Chip mono>from {run.base}</Chip>
        <Chip mono>gates {run.gates.join(", ")}</Chip>
      </div>
      {run.lanes.length === 0 && <p className="m-0 text-xs text-muted">No lanes yet.</p>}
      {byWave(run.lanes).map(([wave, lanes]) => (
        <div key={wave}>
          <SectionLabel>Wave {wave}</SectionLabel>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {lanes.map((lane) => (
              <LaneRow key={lane.id} lane={lane} />
            ))}
          </ul>
        </div>
      ))}
      {run.questions.map((question) => (
        <Notice key={question.id} tone="warn">
          Lane {run.lanes.find((lane) => lane.id === question.laneId)?.name ?? question.laneId}{" "}
          asks: <span className="whitespace-pre-wrap">{question.question}</span>
        </Notice>
      ))}
      {run.state === "running" && <CancelRun run={run} />}
    </section>
  );
}

function StartForm({ projects }: { projects: readonly Project[] }) {
  const api = useApi();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [gates, setGates] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const start = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const gateList = gates
        .split(",")
        .map((gate) => gate.trim())
        .filter(Boolean);
      const body = await api.send("POST", "runs", {
        projectId,
        name,
        ...(base.trim() ? { base: base.trim() } : {}),
        ...(gateList.length > 0 ? { gates: gateList } : {}),
      });
      window.location.hash = `#/workspaces/${parse(RunBody, body, "run").run.workspaceId}`;
    } catch (caught) {
      setError(message(caught));
    }
    setBusy(false);
  };

  return (
    <Panel>
      <PanelHeader title="Start a run" />
      <form onSubmit={(event) => void start(event)} className="flex flex-col gap-3">
        {error && <Notice tone="fail">{error}</Notice>}
        <Field label="Project">
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Base (optional)">
          <Input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            placeholder="The current line"
          />
        </Field>
        <Field label="Gates (optional, comma list)">
          <Input
            value={gates}
            onChange={(event) => setGates(event.target.value)}
            placeholder="check, test"
          />
        </Field>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || projectId === "" || name.trim() === ""}
          >
            {busy && <Spinner />}
            Start
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function RunsPage() {
  const api = useApi();
  const runs = useRuns();
  const [projects, setProjects] = useState<Project[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    api
      .get("projects")
      .then((raw) => setProjects(parse(ProjectList, raw, "project list").projects))
      .catch((caught) => setError(message(caught)));
  }, [api]);

  return (
    <Page>
      <PageHeader title="Runs" />
      {error && <Notice tone="fail">{error}</Notice>}
      {!runs || !projects ? (
        <Spinner />
      ) : (
        <>
          <StartForm projects={projects} />
          {runs.length === 0 && (
            <EmptyState icon={Network} title="No runs yet">
              Start a run above.
            </EmptyState>
          )}
          {projects
            .filter((project) => runs.some((run) => run.projectId === project.id))
            .map((project) => (
              <div key={project.id} className="flex flex-col gap-2">
                <SectionLabel>{project.name}</SectionLabel>
                {runs
                  .filter((run) => run.projectId === project.id)
                  .map((run) => (
                    <RunCard key={run.id} run={run} />
                  ))}
              </div>
            ))}
        </>
      )}
    </Page>
  );
}

/** In a run workspace: the run. In a lane workspace: a link back to its run. Elsewhere: nothing. */
function RunPanel({ workspace }: { workspace: Workspace }) {
  const runs = useRuns();
  const run = runs?.find((candidate) => candidate.workspaceId === workspace.id);
  if (run) {
    return (
      <CollapsibleSection title="Run">
        <RunCard run={run} />
      </CollapsibleSection>
    );
  }
  const parent = runs?.find((candidate) =>
    candidate.lanes.some((lane) => lane.workspaceId === workspace.id),
  );
  const lane = parent?.lanes.find((candidate) => candidate.workspaceId === workspace.id);
  if (!parent || !lane) return null;
  return (
    <CollapsibleSection title="Run">
      <p className="m-0 text-sm">
        Lane {lane.name} of run <a href={`#/workspaces/${parent.workspaceId}`}>{parent.line}</a>
      </p>
    </CollapsibleSection>
  );
}

let DeclineNote: AttentionWeb["DeclineNote"] | undefined;

/** A `run-pr` approval on Home: the PR the run wants to open. Approve may change only the title and the body. */
function RunPrView({ approval, busy, approve, decline }: ApprovalViewProps) {
  const subject = parse(RunPrSubject, approval.subject, "run-pr approval");
  const [title, setTitle] = useState(subject.title);
  const [body, setBody] = useState(subject.body);
  const [note, setNote] = useState("");
  const Note = DeclineNote as AttentionWeb["DeclineNote"];
  return (
    <div className="flex flex-col gap-2.5 text-sm">
      <p className="m-0">
        From <code>{subject.head}</code> into <code>{subject.base}</code>
      </p>
      <Field label="Title">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={256} />
      </Field>
      <Field label="Description">
        <Textarea rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <Notice>pi-spore never merges this PR. A human does.</Notice>
      <Note note={note} onChange={setNote} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy || title.trim() === ""}
          onClick={() => approve({ ...subject, title: title.trim(), body })}
        >
          Open PR
        </Button>
        <Button disabled={busy} onClick={() => decline(note.trim() || undefined)}>
          Decline
        </Button>
      </div>
    </div>
  );
}

export const runsWeb: WebModule = {
  id: "runs",
  requires: ["workspaces", "attention"],
  core: false,
  setup(host) {
    const attention = host.use(AttentionWebKey);
    DeclineNote = attention.DeclineNote;
    attention.addApprovalView("run-pr", RunPrView);
    host.use(WorkspaceViewKey).addPanel({ id: "run", order: 7, component: RunPanel });
    host.addPage({
      path: "/runs",
      title: "Runs",
      rail: { order: 6, icon: Network },
      component: RunsPage,
    });
  },
};
