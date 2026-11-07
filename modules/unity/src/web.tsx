import { WorkspacePanelsKey } from "@pi-spore/mod-workspaces/web";
import { ApiRequestError, useApi, type WebModule } from "@pi-spore/module-api";
import {
  type OpenEditor,
  OpenUnityResponse,
  parse,
  UnityWorkspaceView,
  type Workspace,
} from "@pi-spore/shared";
import { useCallback, useEffect, useState } from "react";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function where(editor: OpenEditor, workspace: Workspace): string {
  if (editor.path === workspace.path) return "this workspace";
  return editor.workspaceId ? "another workspace" : "the main checkout";
}

/** "Open in Unity" and the project's editor lease (R10.3 to R10.5). Hidden for projects without Unity. */
function UnityPanel({ workspace }: { workspace: Workspace }) {
  const api = useApi();
  const [view, setView] = useState<UnityWorkspaceView | undefined>();
  const [blocked, setBlocked] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setView(
        parse(UnityWorkspaceView, await api.get(`unity/workspaces/${workspace.id}`), "unity"),
      );
    } catch (caught) {
      setError(message(caught));
    }
  }, [api, workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await work();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const open = () =>
    run(async () => {
      try {
        const result = parse(
          OpenUnityResponse,
          await api.send("POST", `unity/workspaces/${workspace.id}/open`),
          "open",
        );
        setBlocked(undefined);
        setNote(
          result.alreadyOpen ? "Unity already has this workspace open." : "Unity is starting.",
        );
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.code === "editor_open") {
          setBlocked(caught.message);
          return;
        }
        throw caught;
      }
    });

  const close = (editor: OpenEditor) => {
    if (view?.unity !== true) return;
    const yes = window.confirm(
      `Close Unity on ${editor.path}?\n\nUnity closes WITHOUT saving. Unsaved changes to scenes, prefabs, and ` +
        "settings are lost. Save in Unity first if you need them.",
    );
    if (!yes) return;
    void run(async () => {
      await api.send("POST", "unity/editors/close", {
        projectId: workspace.projectId,
        path: editor.path,
        confirm: true,
      });
      setNote(`Closed Unity on ${editor.path}.`);
    });
  };

  if (!view) return error ? <p className="error">{error}</p> : null;
  if (!view.unity) return null;
  const { editors, staleLocks, lease, warnings } = view.editors;
  const here = editors.some((editor) => editor.path === workspace.path);
  const elsewhere = editors.filter((editor) => editor.path !== workspace.path);
  return (
    <section>
      <h2>Unity</h2>
      <p className="muted">Editor {view.editorVersion}. One editor per project at a time.</p>
      {editors.length === 0 && <p className="muted">No Unity editor has this project open.</p>}
      {editors.map((editor) => (
        <p key={editor.path}>
          Open in {where(editor, workspace)}: <code>{editor.path}</code>{" "}
          <span className="badge">{editor.state ?? "open"}</span>
          {editor.pid !== undefined && <span className="muted"> pid {editor.pid}</span>}
          {lease?.path === editor.path && (
            <span className="muted"> held by {lease.owner === "user" ? "you" : "an agent"}</span>
          )}{" "}
          <button type="button" disabled={busy} onClick={() => close(editor)}>
            Close without saving
          </button>
        </p>
      ))}
      {staleLocks.map((path) => (
        <p key={path} className="muted">
          <code>{path}/Temp/UnityLockfile</code> is left over: no editor runs there. It does not
          block.
        </p>
      ))}
      {warnings.map((warning) => (
        <p key={warning} className="muted">
          {warning}
        </p>
      ))}
      {blocked && elsewhere.length > 0 && (
        <p className="warning">
          {blocked} Use "Close without saving" above after you save in Unity, then open again.
        </p>
      )}
      <button
        type="button"
        disabled={busy || workspace.state === "archived" || here}
        onClick={() => void open()}
      >
        {here ? "Open in Unity (already open)" : "Open in Unity"}
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => void run(async () => {})}>
        Refresh
      </button>
      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export const unityWeb: WebModule = {
  id: "unity",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    host.use(WorkspacePanelsKey).add({ id: "unity", order: 20, component: UnityPanel });
  },
};
