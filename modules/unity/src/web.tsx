import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { ApiRequestError, useApi, type WebModule } from "@pi-spore/module-api";
import {
  type OpenEditor,
  OpenUnityResponse,
  parse,
  UnityWorkspaceView,
  type Workspace,
} from "@pi-spore/shared";
import { Button, Chip, CollapsibleSection, Notice } from "@pi-spore/ui";
import { Box, RefreshCw } from "lucide-react";
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

  if (!view)
    return error ? (
      <CollapsibleSection title="Unity">
        <Notice tone="fail">{error}</Notice>
      </CollapsibleSection>
    ) : null;
  if (!view.unity) return null;
  const { editors, staleLocks, lease, warnings } = view.editors;
  const here = editors.some((editor) => editor.path === workspace.path);
  const elsewhere = editors.filter((editor) => editor.path !== workspace.path);
  return (
    <CollapsibleSection title="Unity">
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0 text-xs text-muted">
          Editor <span className="font-mono">{view.editorVersion}</span>. One editor per project at
          a time.
        </p>
        {editors.length === 0 && (
          <p className="m-0 text-muted">No Unity editor has this project open.</p>
        )}
        {editors.map((editor) => (
          <div
            key={editor.path}
            className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-2"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span>Open in {where(editor, workspace)}</span>
              <Chip tone="run">{editor.state ?? "open"}</Chip>
              {editor.pid !== undefined && (
                <span className="font-mono text-xs text-muted">pid {editor.pid}</span>
              )}
              {lease?.path === editor.path && (
                <span className="text-xs text-muted">
                  held by {lease.owner === "user" ? "you" : "an agent"}
                </span>
              )}
            </div>
            <code className="text-xs [overflow-wrap:anywhere] text-muted">{editor.path}</code>
            <div>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => close(editor)}>
                Close without saving
              </Button>
            </div>
          </div>
        ))}
        {staleLocks.map((path) => (
          <p key={path} className="m-0 text-xs text-muted">
            <code className="[overflow-wrap:anywhere]">{path}/Temp/UnityLockfile</code> is left
            over: no editor runs there. It does not block.
          </p>
        ))}
        {warnings.map((warning) => (
          <Notice key={warning}>{warning}</Notice>
        ))}
        {blocked && elsewhere.length > 0 && (
          <Notice tone="warn">
            {blocked} Use "Close without saving" above after you save in Unity, then open again.
          </Notice>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="primary"
            disabled={busy || workspace.state === "archived" || here}
            onClick={() => void open()}
          >
            <Box />
            {here ? "Open in Unity (already open)" : "Open in Unity"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            title="Refresh"
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            <RefreshCw />
          </Button>
        </div>
        {note && <p className="m-0 text-muted">{note}</p>}
        {error && <Notice tone="fail">{error}</Notice>}
      </div>
    </CollapsibleSection>
  );
}

export const unityWeb: WebModule = {
  id: "unity",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    host.use(WorkspaceViewKey).addPanel({ id: "unity", order: 20, component: UnityPanel });
  },
};
