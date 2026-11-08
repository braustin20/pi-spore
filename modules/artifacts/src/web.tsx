import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import { type ArtifactInfo, ArtifactsEvent, parse, type Workspace } from "@pi-spore/shared";
import { Button, ContentDialog, EmptyState, ListRow, Notice, SectionLabel } from "@pi-spore/ui";
import { FileText } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ArtifactView } from "./viewer.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const fileUrl = (artifact: ArtifactInfo) =>
  `artifacts/${artifact.scope === "workspace" ? "workspaces" : "projects"}/${artifact.ownerId}/file?path=${encodeURIComponent(artifact.path)}`;

function ArtifactRow({
  artifact,
  selected,
  onSelect,
  onPromote,
}: {
  artifact: ArtifactInfo;
  selected: boolean;
  onSelect: () => void;
  /** Only workspace rows can be promoted. */
  onPromote?: () => void;
}) {
  return (
    <li className="flex items-center gap-2">
      <ListRow
        href="#"
        selected={selected}
        onClick={(event) => {
          event.preventDefault();
          onSelect();
        }}
        className="min-w-0 flex-1"
      >
        <span className="block truncate font-mono text-xs" title={artifact.path}>
          {artifact.path}
        </span>
        <span className="block text-xs text-muted">
          {formatBytes(artifact.bytes)}
          {artifact.promotedFrom && ` · promoted from ${artifact.promotedFrom}`}
        </span>
      </ListRow>
      {onPromote && (
        <Button size="sm" variant="ghost" onClick={onPromote}>
          Promote to project
        </Button>
      )}
    </li>
  );
}

function ArtifactList({
  label,
  empty,
  artifacts,
  selected,
  onSelect,
  onPromote,
}: {
  label: string;
  empty: string;
  artifacts: readonly ArtifactInfo[];
  selected: ArtifactInfo | undefined;
  onSelect: (artifact: ArtifactInfo) => void;
  onPromote?: (artifact: ArtifactInfo) => void;
}) {
  return (
    <section className="px-3 py-2" aria-label={label}>
      <SectionLabel marker>{label}</SectionLabel>
      {artifacts.length === 0 ? (
        <p className="m-0 py-2 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="m-0 list-none p-0 pt-1">
          {artifacts.map((artifact) => (
            <ArtifactRow
              key={`${artifact.scope}:${artifact.path}`}
              artifact={artifact}
              selected={selected?.scope === artifact.scope && selected.path === artifact.path}
              onSelect={() => onSelect(artifact)}
              {...(onPromote ? { onPromote: () => onPromote(artifact) } : {})}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Artifacts tab (R14.2): the workspace's and the project's files, and one viewer. */
function ArtifactsTab({ workspace }: { workspace: Workspace }) {
  const api = useApi();
  const [lists, setLists] = useState<ArtifactsEvent | undefined>();
  const [selected, setSelected] = useState<ArtifactInfo | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(
    () =>
      api.subscribe(`artifacts:${workspace.id}`, (raw) => {
        setLists(parse(ArtifactsEvent, raw, "artifacts event"));
      }),
    [api, workspace.id],
  );

  const promote = (artifact: ArtifactInfo) => {
    setError(undefined);
    api
      .send("POST", `artifacts/workspaces/${workspace.id}/promote`, { path: artifact.path })
      .catch((caught: unknown) => setError(`${artifact.path}: ${message(caught)}`));
  };

  if (!lists) return null;
  if (lists.workspace.length === 0 && lists.project.length === 0) {
    return (
      <EmptyState icon={FileText} title="No artifacts yet">
        Files the agent saves as artifacts show here, for this workspace and for the project.
      </EmptyState>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line">
        {error && (
          <Notice tone="fail" className="m-2">
            {error}
          </Notice>
        )}
        <ArtifactList
          label="This workspace"
          empty="This workspace has no artifacts."
          artifacts={lists.workspace}
          selected={selected}
          onSelect={setSelected}
          onPromote={promote}
        />
        <ArtifactList
          label="Project"
          empty="The project has no artifacts."
          artifacts={lists.project}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <ArtifactView key={fileUrl(selected)} source={fileUrl(selected)} name={selected.path} />
        ) : (
          <p className="m-0 p-4 text-sm text-muted">Select a file to read it.</p>
        )}
      </div>
    </div>
  );
}

/**
 * A Markdown file the agent linked in the chat. A click opens it over the page. The dialog sits in the document body,
 * because the link is inside a paragraph.
 */
function FileLink({
  workspaceId,
  path,
  children,
}: {
  workspaceId: string;
  path: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={path}
        className="cursor-pointer border-0 bg-transparent p-0 text-left text-accent-strong underline"
      >
        {children}
      </button>
      <ContentDialog open={open} onOpenChange={setOpen} title={path}>
        <ArtifactView
          source={`artifacts/workspaces/${workspaceId}/view?path=${encodeURIComponent(path)}`}
          name={path}
        />
      </ContentDialog>
    </>
  );
}

export const artifactsWeb: WebModule = {
  id: "artifacts",
  requires: ["workspaces", "agents"],
  core: true,
  setup(host) {
    host.use(WorkspaceViewKey).addTab({
      id: "artifacts",
      title: "Artifacts",
      order: 3,
      wide: true,
      component: ArtifactsTab,
    });
    host.use(AgentsWebKey).setFileLink(FileLink);
  },
};
