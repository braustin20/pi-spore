import { WorkspacePanelsKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  ActionList,
  ActionLog,
  type ActionRun,
  ActionRunList,
  ActionRun as ActionRunSchema,
  type ActionView,
  parse,
  type Workspace,
} from "@pi-spore/shared";
import { useCallback, useEffect, useState } from "react";
import Type from "typebox";

const RunBody = Type.Object({ run: ActionRunSchema });
/** The log view keeps this many characters; the full log stays on disk. */
const MAX_SHOWN = 200_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const commandText = (action: ActionView) =>
  typeof action.run === "string" ? action.run : action.run.join(" ");
const open = (run: ActionRun) => run.status === "queued" || run.status === "running";

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

  return (
    <div>
      <p className="muted">
        {run && (
          <>
            {run.action}: <span className="badge">{statusText(run)}</span> log{" "}
            <code>{run.logPath}</code>
          </>
        )}
      </p>
      {run?.error && <p className="error">{run.error}</p>}
      {error && <p className="error">{error}</p>}
      <pre className="tool-output">{text || " "}</pre>
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
    <section>
      <h2>Actions</h2>
      {error && <p className="error">{error}</p>}
      {actions === undefined && !error && <p className="muted">Loading...</p>}
      {actions?.length === 0 && (
        <p className="muted">
          No actions. Add them as <code>[actions.&lt;name&gt;]</code> in{" "}
          <code>.pi-spore/config.toml</code>.
        </p>
      )}
      {actions && actions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Command</th>
              <th>From</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => (
              <tr key={action.name}>
                <td>
                  {action.name}
                  {action.exclusive && <span className="badge">exclusive</span>}
                  {action.description && <div className="muted">{action.description}</div>}
                </td>
                <td>
                  <code>
                    {action.shell ? "sh -c " : ""}
                    {commandText(action)}
                  </code>
                </td>
                <td className="muted">{action.source}</td>
                <td>
                  <button type="button" disabled={!active} onClick={() => start(action.name)}>
                    Run
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {runs.length > 0 && (
        <>
          <h3>Runs</h3>
          <table>
            <tbody>
              {runs.slice(0, 10).map((run) => (
                <tr key={run.id}>
                  <td>{run.action}</td>
                  <td>
                    <span className={`badge status-${run.status}`}>{statusText(run)}</span>
                  </td>
                  <td className="muted">{run.trigger === "user" ? "" : `on ${run.trigger}`}</td>
                  <td className="muted">{new Date(run.createdAt).toLocaleString()}</td>
                  <td>
                    <button type="button" onClick={() => setSelected(run.id)}>
                      Log
                    </button>{" "}
                    {open(run) && (
                      <button type="button" onClick={() => cancel(run)}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {selected && <RunLog runId={selected} onEnded={loadRuns} />}
    </section>
  );
}

export const actionsWeb: WebModule = {
  id: "actions",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    host.use(WorkspacePanelsKey).add({ id: "actions", order: 10, component: ActionsPanel });
  },
};
