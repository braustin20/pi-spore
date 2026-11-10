import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  ActionList,
  ActionLog,
  type ActionRun,
  ActionRunList,
  ActionRun as ActionRunSchema,
  type ActionView,
  parse,
  stripAnsi,
  type Workspace,
} from "@pi-spore/shared";
import { Button, Chip, CollapsibleSection, Notice, SectionLabel, type Tone } from "@pi-spore/ui";
import { Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Type from "typebox";

const RunBody = Type.Object({ run: ActionRunSchema });
/** The log view keeps this many characters; the full log stays on disk. */
const MAX_SHOWN = 200_000;

/** Loopback URLs only: a run's own dev server. The capture group makes `split` keep them at odd indexes. */
const LOOPBACK_URL = /(http:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s"'()[\]]*)?)/;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const commandText = (action: ActionView) =>
  typeof action.run === "string" ? action.run : action.run.join(" ");
const open = (run: ActionRun) => run.status === "queued" || run.status === "running";

const RUN_TONE: Record<ActionRun["status"], Tone> = {
  queued: "neutral",
  running: "run",
  succeeded: "ok",
  failed: "fail",
  cancelled: "neutral",
  interrupted: "warn",
};

function statusText(run: ActionRun): string {
  if (run.status === "failed" && run.exitCode !== undefined) return `failed (exit ${run.exitCode})`;
  return run.status;
}

/** Shows a run's log and follows it while it runs, through the server's long poll. */
function RunLog({ runId, onEnded }: { runId: string; onEnded: () => void }) {
  const api = useApi();
  const [text, setText] = useState("");
  const [run, setRun] = useState<ActionRun | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let stopped = false;
    setText("");
    setError(undefined);
    const follow = async () => {
      let from: number | undefined;
      for (;;) {
        const query = from === undefined ? "" : `?from=${from}&wait=15000`;
        const log = parse(ActionLog, await api.get(`actions/runs/${runId}/log${query}`), "log");
        if (stopped) return;
        setRun(log.run);
        setText((shown) => (from === undefined ? log.text : shown + log.text).slice(-MAX_SHOWN));
        from = log.end;
        if (!open(log.run) && log.end >= log.size) {
          onEnded();
          return;
        }
      }
    };
    follow().catch((caught: unknown) => {
      if (!stopped) setError(message(caught));
    });
    return () => {
      stopped = true;
    };
  }, [api, runId, onEnded]);

  const parts = stripAnsi(text).split(LOOPBACK_URL);
  const newestUrl = parts.findLast((_, index) => index % 2 === 1);
  return (
    <div className="flex flex-col gap-2">
      {run && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{run.action}</span>
          <Chip tone={RUN_TONE[run.status]}>{statusText(run)}</Chip>
          {run.status === "running" && newestUrl && (
            <Button asChild size="sm">
              <a href={newestUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </Button>
          )}
          <code className="[overflow-wrap:anywhere] text-muted">{run.logPath}</code>
        </div>
      )}
      {run?.error && <Notice tone="fail">{run.error}</Notice>}
      {error && <Notice tone="fail">{error}</Notice>}
      <pre className="m-0 max-h-80 overflow-auto rounded-md border border-line bg-bg p-2.5 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-muted">
        {text
          ? parts.map((part, index) =>
              index % 2 === 1 ? (
                <a
                  // biome-ignore lint/suspicious/noArrayIndexKey: the parts have no identity besides their place
                  key={index}
                  href={part}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  {part}
                </a>
              ) : (
                part
              ),
            )
          : " "}
      </pre>
    </div>
  );
}

function ActionsPanel({ workspace }: { workspace: Workspace }) {
  const api = useApi();
  const [actions, setActions] = useState<ActionView[] | undefined>();
  const [runs, setRuns] = useState<ActionRun[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const loadRuns = useCallback(() => {
    api
      .get(`actions/workspaces/${workspace.id}/runs`)
      .then((body) => setRuns(parse(ActionRunList, body, "runs").runs))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, workspace.id]);

  useEffect(() => {
    api
      .get(`actions/workspaces/${workspace.id}`)
      .then((body) => setActions(parse(ActionList, body, "actions").actions))
      .catch((caught: unknown) => setError(message(caught)));
    loadRuns();
  }, [api, workspace.id, loadRuns]);

  const start = (name: string) => {
    setError(undefined);
    api
      .send("POST", `actions/workspaces/${workspace.id}/runs`, { action: name })
      .then((body) => {
        setSelected(parse(RunBody, body, "run").run.id);
        loadRuns();
      })
      .catch((caught: unknown) => setError(message(caught)));
  };

  const cancel = (run: ActionRun) => {
    api
      .send("POST", `actions/runs/${run.id}/cancel`)
      .then(loadRuns)
      .catch((caught: unknown) => setError(message(caught)));
  };

  const active = workspace.state === "active";
  return (
    <CollapsibleSection title="Actions">
      <div className="flex flex-col gap-3 text-sm">
        {error && <Notice tone="fail">{error}</Notice>}
        {actions === undefined && !error && <p className="m-0 text-muted">Loading...</p>}
        {actions?.length === 0 && (
          <p className="m-0 text-muted">
            No actions. Add them as <code>[actions.&lt;name&gt;]</code> in{" "}
            <code>.pi-spore/config.toml</code>.
          </p>
        )}
        {actions && actions.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {actions.map((action) => (
              <li
                key={action.name}
                className="flex items-start gap-2 rounded-lg border border-line bg-raised px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{action.name}</span>
                    {action.exclusive && <Chip>exclusive</Chip>}
                    <span className="text-xs text-muted">{action.source}</span>
                  </div>
                  {action.description && (
                    <div className="text-xs text-muted">{action.description}</div>
                  )}
                  <code className="block truncate text-xs text-muted" title={commandText(action)}>
                    {action.shell ? "sh -c " : ""}
                    {commandText(action)}
                  </code>
                </div>
                <Button
                  size="sm"
                  disabled={!active}
                  onClick={() => start(action.name)}
                  aria-label={`Run ${action.name}`}
                >
                  <Play />
                  Run
                </Button>
              </li>
            ))}
          </ul>
        )}
        {runs.length > 0 && (
          <div className="flex flex-col gap-1">
            <SectionLabel>Runs</SectionLabel>
            <ul className="m-0 flex list-none flex-col p-0">
              {runs.slice(0, 10).map((run) => (
                <li
                  key={run.id}
                  className={`flex items-center gap-2 rounded-md px-1.5 py-1 ${run.id === selected ? "bg-raised" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {run.action}
                    {run.trigger !== "user" && (
                      <span className="text-xs text-muted"> on {run.trigger}</span>
                    )}
                  </span>
                  <Chip tone={RUN_TONE[run.status]}>{statusText(run)}</Chip>
                  <span
                    className="font-mono text-[11px] text-muted"
                    title={new Date(run.createdAt).toLocaleString()}
                  >
                    {new Date(run.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(run.id)}>
                    Log
                  </Button>
                  {open(run) && (
                    <Button size="sm" variant="danger" onClick={() => cancel(run)}>
                      Cancel
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {selected && <RunLog runId={selected} onEnded={loadRuns} />}
      </div>
    </CollapsibleSection>
  );
}

export const actionsWeb: WebModule = {
  id: "actions",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    host.use(WorkspaceViewKey).addPanel({ id: "actions", order: 10, component: ActionsPanel });
  },
};
