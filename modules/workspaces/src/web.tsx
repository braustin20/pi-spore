import { ApiRequestError, useApi, type WebModule } from "@pi-spore/module-api";
import {
  ArchiveWorkspaceResponse,
  CreateWorkspaceResponse,
  type Isolation,
  type Project,
  ProjectLines,
  ProjectList,
  parse,
  type StepReport,
  type Workspace,
  WorkspaceList,
} from "@pi-spore/shared";
import {
  Button,
  Checkbox,
  Chip,
  CollapsibleSection,
  EmptyState,
  Field,
  Input,
  ListRow,
  Notice,
  Panel,
  PanelHeader,
  SectionLabel,
  Select,
  StatusLine,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  useStoredFlag,
} from "@pi-spore/ui";
import {
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { ago, groupWorkspaces } from "./list.js";
import {
  type UseWorkspaceStatus,
  type WorkspacePanel,
  type WorkspaceStatus,
  WorkspaceViewKey,
} from "./web-contract.js";

export * from "./web-contract.js";

interface Note {
  text: string;
  error?: boolean;
}

const stepNote = (step: StepReport): Note => ({
  text: step.message,
  ...(step.ok ? {} : { error: true }),
});

/** Filled by other web modules during setup; read when the workspace view renders. */
const panels: WorkspacePanel[] = [];
let Main: ComponentType<{ workspace: Workspace; chatId?: string }> | undefined;
const NO_STATUS: ReadonlyMap<string, WorkspaceStatus> = new Map();
const noStatus: UseWorkspaceStatus = () => NO_STATUS;
let useStatus = noStatus;

const MODE_LABELS: Record<Isolation, string> = {
  new: "New worktree on a new branch",
  existing: "Worktree on an existing branch",
  "in-place": "Main checkout (no copy)",
};

const ISOLATION_CHIP: Record<Isolation, string> = {
  new: "worktree",
  existing: "worktree",
  "in-place": "main checkout",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function CreateForm({
  projects,
  projectId,
  onCreated,
}: {
  projects: readonly Project[];
  projectId: string | undefined;
  onCreated: (workspace: Workspace, notes: Note[]) => void;
}) {
  const api = useApi();
  const [chosen, setChosen] = useState(projectId ?? projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Isolation>("new");
  const [lines, setLines] = useState<string[]>([]);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const project = projects.find((candidate) => candidate.id === chosen);
  const modes: Isolation[] =
    project?.vcs === "git" ? ["new", "existing", "in-place"] : ["new", "in-place"];

  useEffect(() => {
    if (projectId) setChosen(projectId);
  }, [projectId]);

  useEffect(() => {
    setLines([]);
    setLine("");
    if (project?.vcs !== "git") return;
    api
      .get(`projects/${project.id}/lines`)
      .then((body) => {
        const result = parse(ProjectLines, body, "branches");
        setLines(result.lines);
        setLine(
          result.lines.find((candidate) => candidate !== result.current) ?? result.lines[0] ?? "",
        );
      })
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, project]);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!project) return;
    setBusy(true);
    setError(undefined);
    api
      .send("POST", "workspaces", {
        projectId: project.id,
        name: name.trim(),
        isolation: mode,
        ...(mode === "existing" ? { line } : {}),
      })
      .then((body) => {
        const result = parse(CreateWorkspaceResponse, body, "create workspace");
        setName("");
        onCreated(result.workspace, [
          ...result.warnings.map((text) => ({ text })),
          ...(result.copied.length
            ? [{ text: `Copied into the worktree: ${result.copied.join(", ")}` }]
            : []),
          ...result.steps.map(stepNote),
        ]);
      })
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <Panel className="w-full max-w-xl">
      <PanelHeader title="Start a workspace" />
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Project">
          <Select value={chosen} onChange={(event) => setChosen(event.target.value)}>
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Fix crafting UI"
          />
        </Field>
        <Field label="Where">
          <Select value={mode} onChange={(event) => setMode(event.target.value as Isolation)}>
            {modes.map((candidate) => (
              <option key={candidate} value={candidate}>
                {MODE_LABELS[candidate]}
              </option>
            ))}
          </Select>
        </Field>
        {mode === "existing" && (
          <Field label="Branch">
            <Select
              value={line}
              onChange={(event) => setLine(event.target.value)}
              className="font-mono"
            >
              {lines.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {error && <Notice tone="fail">{error}</Notice>}
        <div>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !project || name.trim() === "" || (mode === "existing" && !line)}
          >
            {busy ? "Creating..." : "Start workspace"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function WorkspaceRow({
  workspace,
  project,
  status,
  selected,
  now,
}: {
  workspace: Workspace;
  project: string;
  status: WorkspaceStatus | undefined;
  selected: boolean;
  now: number;
}) {
  return (
    <ListRow href={`#/workspaces/${workspace.id}`} selected={selected}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {ago(workspace.updatedAt, now)}
        </span>
      </div>
      <div className="truncate text-xs text-muted">
        {project}
        {workspace.line && <span className="font-mono"> · {workspace.line}</span>}
      </div>
      {status && (
        <StatusLine tone={status.tone} className="mt-0.5 max-w-full">
          {status.text}
        </StatusLine>
      )}
    </ListRow>
  );
}

function WorkspaceListColumn({
  workspaces,
  projects,
  selectedId,
  projectId,
  error,
  onCollapse,
}: {
  workspaces: readonly Workspace[] | undefined;
  projects: readonly Project[];
  selectedId: string | undefined;
  projectId: string | undefined;
  error: string | undefined;
  onCollapse: () => void;
}) {
  const [showArchived, setShowArchived] = useStoredFlag("pi-spore.workspaces.archived", false);
  const statuses = useStatus(workspaces ?? []);
  const projectName = (id: string) => projects.find((candidate) => candidate.id === id)?.name ?? id;
  const groups = groupWorkspaces(workspaces ?? [], { showArchived, projectId });
  const now = Date.now();
  return (
    <aside
      aria-label="Workspaces"
      className="flex w-64 shrink-0 flex-col border-r border-line bg-panel xl:w-72"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
        <SectionLabel className="flex-1">Workspaces</SectionLabel>
        <Tooltip label="New workspace" side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label="New workspace" asChild>
            <a href={projectId ? `#/workspaces/in/${projectId}` : "#/workspaces"}>
              <Plus />
            </a>
          </Button>
        </Tooltip>
        <Tooltip label="Hide the list" side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label="Hide the list" onClick={onCollapse}>
            <PanelLeftClose />
          </Button>
        </Tooltip>
      </div>
      {projectId && (
        <div className="flex items-center gap-1.5 px-4 pt-3">
          <Chip tone="accent" className="inline-flex items-center gap-1">
            {projectName(projectId)}
            <a
              href="#/workspaces"
              aria-label="Show all projects"
              className="inline-flex text-accent-strong"
            >
              <X className="size-3" />
            </a>
          </Chip>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
        {error && <Notice tone="fail">{error}</Notice>}
        {workspaces === undefined && !error && (
          <p className="px-2 text-sm text-muted">Loading...</p>
        )}
        {workspaces !== undefined && groups.length === 0 && (
          <p className="px-2 text-sm text-muted">No workspaces.</p>
        )}
        {groups.map((group) => (
          <section key={group.state} aria-label={group.label} className="flex flex-col gap-0.5">
            <SectionLabel className="px-3 pb-1">
              {group.label}
              <span className="font-mono">{group.workspaces.length}</span>
            </SectionLabel>
            {group.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                project={projectName(workspace.projectId)}
                status={statuses.get(workspace.id)}
                selected={workspace.id === selectedId}
                now={now}
              />
            ))}
          </section>
        ))}
      </div>
      <div className="shrink-0 border-t border-line px-4 py-2">
        <Checkbox
          label="Show archived"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
      </div>
    </aside>
  );
}

/** What the workspace is, and rename, park, resume, and archive. */
function Details({
  workspace,
  project,
  onChanged,
  onNotes,
}: {
  workspace: Workspace;
  project: Project | undefined;
  onChanged: () => void;
  onNotes: (notes: Note[]) => void;
}) {
  const api = useApi();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const act = (promise: Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    return promise
      .then(onChanged)
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false));
  };

  const rename = (event: SubmitEvent) => {
    event.preventDefault();
    const name = renaming?.trim();
    if (!name || name === workspace.name) {
      setRenaming(undefined);
      return;
    }
    void act(api.send("PATCH", `workspaces/${workspace.id}`, { name })).then(() =>
      setRenaming(undefined),
    );
  };

  const archive = async () => {
    const what =
      workspace.isolation === "in-place" ? "" : " Its copy will be removed; the branch stays.";
    if (!window.confirm(`Archive "${workspace.name}"?${what}`)) return;
    const send = async (force: boolean) =>
      parse(
        ArchiveWorkspaceResponse,
        await api.send("POST", `workspaces/${workspace.id}/archive`, force ? { force } : {}),
        "archive",
      );
    setBusy(true);
    setError(undefined);
    try {
      onNotes((await send(false)).steps.map(stepNote));
    } catch (caught) {
      // A failed step such as teardown answers `<step>_failed`; force skips it and any uncommitted-work check.
      const question =
        caught instanceof ApiRequestError && caught.code === "uncommitted_work"
          ? "Delete the uncommitted work and archive anyway?"
          : caught instanceof ApiRequestError && caught.code.endsWith("_failed")
            ? "Archive anyway? This also deletes any uncommitted work in the copy."
            : undefined;
      if (!question) setError(message(caught));
      else if (window.confirm(`${(caught as Error).message}\n\n${question}`)) {
        await send(true)
          .then((result) => onNotes(result.steps.map(stepNote)))
          .catch((forced: unknown) => setError(message(forced)));
      }
    } finally {
      setBusy(false);
    }
    onChanged();
  };

  const stateTone =
    workspace.state === "active" ? "ok" : workspace.state === "parked" ? "warn" : "neutral";
  return (
    <CollapsibleSection title="Workspace">
      <div className="flex flex-col gap-3 text-sm">
        {renaming === undefined ? (
          <div className="text-base font-medium [overflow-wrap:anywhere]">{workspace.name}</div>
        ) : (
          <form onSubmit={rename} className="flex gap-1.5">
            <Input
              aria-label="New name"
              value={renaming}
              onChange={(event) => setRenaming(event.target.value)}
              className="min-w-0 flex-1"
              autoFocus
            />
            <Button type="submit" size="md" disabled={busy || renaming.trim() === ""}>
              Save
            </Button>
          </form>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Chip tone={stateTone}>{workspace.state}</Chip>
          <Chip>{ISOLATION_CHIP[workspace.isolation]}</Chip>
          {workspace.line && <Chip mono>{workspace.line}</Chip>}
        </div>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Project</dt>
          <dd className="m-0 truncate">
            <a href={`#/projects/${workspace.projectId}`}>{project?.name ?? workspace.projectId}</a>
          </dd>
          <dt className="text-muted">Folder</dt>
          <dd className="m-0 font-mono [overflow-wrap:anywhere]">{workspace.path}</dd>
        </dl>
        {error && <Notice tone="fail">{error}</Notice>}
        {workspace.state !== "archived" && (
          <div className="flex flex-wrap gap-1.5">
            {renaming === undefined ? (
              <Button size="sm" disabled={busy} onClick={() => setRenaming(workspace.name)}>
                Rename
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setRenaming(undefined)}>
                Cancel rename
              </Button>
            )}
            {workspace.state === "active" ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act(api.send("POST", `workspaces/${workspace.id}/park`))}
              >
                Park
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act(api.send("POST", `workspaces/${workspace.id}/resume`))}
              >
                Resume
              </Button>
            )}
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void archive()}>
              Archive
            </Button>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

function RightColumn({
  workspace,
  project,
  onChanged,
  onNotes,
  onCollapse,
}: {
  workspace: Workspace;
  project: Project | undefined;
  onChanged: () => void;
  onNotes: (notes: Note[]) => void;
  onCollapse: () => void;
}) {
  return (
    <aside
      aria-label="Workspace details"
      className="flex w-80 shrink-0 flex-col border-l border-line bg-panel xl:w-88"
    >
      {/* Changes and PR tabs join this bar later. */}
      <Tabs defaultValue="details" className="min-h-0 flex-1">
        <div className="flex h-11 shrink-0 items-end border-b border-line pr-2">
          <TabsList className="flex-1 border-b-0">
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>
          <Tooltip label="Hide details" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide details"
              onClick={onCollapse}
              className="mb-2"
            >
              <PanelRightClose />
            </Button>
          </Tooltip>
        </div>
        <TabsContent value="details" className="overflow-y-auto">
          {/* Keyed by id, so a rename or error of one workspace does not carry over to the next. */}
          <Details
            key={workspace.id}
            workspace={workspace}
            project={project}
            onChanged={onChanged}
            onNotes={onNotes}
          />
          {[...panels]
            .sort((a, b) => a.order - b.order)
            .map((panel) => (
              <panel.component key={panel.id} workspace={workspace} />
            ))}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/** A thin strip in place of a hidden column, with the button that shows it again. */
function CollapsedColumn({
  label,
  side,
  onExpand,
}: {
  label: string;
  side: "left" | "right";
  onExpand: () => void;
}) {
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  return (
    <div
      className={`flex w-10 shrink-0 flex-col items-center border-line bg-panel py-2 ${side === "left" ? "border-r" : "border-l"}`}
    >
      <Tooltip label={label} side={side === "left" ? "right" : "left"}>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onExpand}>
          <Icon />
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * The three panes: workspace list, the selected workspace's chat (or the create form), and its details with the
 * module panels. One component for every workspaces route, so the list keeps its state while you move between
 * workspaces.
 */
function WorkspacesView({ params }: { params: Readonly<Record<string, string>> }) {
  const api = useApi();
  const selectedId = params.workspaceId;
  const projectId = params.projectId;
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[] | undefined>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [listOpen, setListOpen] = useStoredFlag("pi-spore.workspaces.list", true);
  const [rightOpen, setRightOpen] = useStoredFlag(
    "pi-spore.workspaces.details",
    window.innerWidth >= 1100,
  );

  const load = useCallback(() => {
    api
      .get("workspaces")
      .then((body) => {
        setWorkspaces(parse(WorkspaceList, body, "workspace list").workspaces);
        setError(undefined);
      })
      .catch((caught: unknown) => setError(message(caught)));
  }, [api]);

  useEffect(() => {
    api
      .get("projects")
      .then((body) => setProjects(parse(ProjectList, body, "project list").projects))
      .catch((caught: unknown) => setError(message(caught)));
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [api, load]);

  // Notes belong to the workspace they were made for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clears on selection change only
  useEffect(() => setNotes([]), [selectedId]);

  const workspace = workspaces?.find((candidate) => candidate.id === selectedId);
  const project = projects.find((candidate) => candidate.id === workspace?.projectId);

  let middle: ReactNode;
  if (selectedId && workspaces && !workspace) {
    middle = (
      <EmptyState icon={Layers} title="No such workspace">
        It may have been removed. Pick one from the list.
      </EmptyState>
    );
  } else if (workspace) {
    middle = Main ? (
      <Main workspace={workspace} {...(params.chatId ? { chatId: params.chatId } : {})} />
    ) : (
      <EmptyState icon={Layers} title={workspace.name}>
        No module shows a workspace here.
      </EmptyState>
    );
  } else if (selectedId) {
    middle = null;
  } else if (projects.length === 0) {
    middle = (
      <EmptyState
        icon={Layers}
        title="No projects yet"
        action={
          <Button variant="primary" asChild>
            <a href="#/projects">Add a project</a>
          </Button>
        }
      >
        A workspace is a copy of a project for one piece of work. Add a project first.
      </EmptyState>
    );
  } else {
    middle = (
      <div className="flex h-full items-start justify-center overflow-y-auto px-6 py-10">
        <CreateForm
          projects={projects}
          projectId={projectId}
          onCreated={(created, createdNotes) => {
            load();
            window.location.hash = `#/workspaces/${created.id}`;
            // After the hash change, so the selection change does not clear them.
            setTimeout(() => setNotes(createdNotes), 0);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {listOpen ? (
        <WorkspaceListColumn
          workspaces={workspaces}
          projects={projects}
          selectedId={selectedId}
          projectId={projectId}
          error={error}
          onCollapse={() => setListOpen(false)}
        />
      ) : (
        <CollapsedColumn label="Show the list" side="left" onExpand={() => setListOpen(true)} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {notes.length > 0 && (
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-4 py-3">
            {notes.map((note) => (
              <Notice key={note.text} tone={note.error ? "fail" : "warn"}>
                {note.text}
              </Notice>
            ))}
            <div>
              <Button size="sm" variant="ghost" onClick={() => setNotes([])}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">{middle}</div>
      </div>
      {workspace &&
        (rightOpen ? (
          <RightColumn
            workspace={workspace}
            project={project}
            onChanged={load}
            onNotes={setNotes}
            onCollapse={() => setRightOpen(false)}
          />
        ) : (
          <CollapsedColumn label="Show details" side="right" onExpand={() => setRightOpen(true)} />
        ))}
    </div>
  );
}

export const workspacesWeb: WebModule = {
  id: "workspaces",
  requires: ["projects"],
  core: true,
  setup(host) {
    host.provide(WorkspaceViewKey, {
      addPanel: (panel) => {
        if (panels.some((existing) => existing.id === panel.id))
          throw new Error(`Workspace panel "${panel.id}" is added twice`);
        panels.push(panel);
      },
      setMain: (component) => {
        if (Main) throw new Error("The workspace main pane is set twice");
        Main = component;
      },
      setStatus: (hook) => {
        if (useStatus !== noStatus) throw new Error("The workspace status source is set twice");
        useStatus = hook;
      },
    });
    host.addPage({
      path: "/workspaces",
      title: "Workspaces",
      rail: { order: 10, icon: Layers },
      component: WorkspacesView,
    });
    host.addPage({
      path: "/workspaces/in/:projectId",
      title: "Workspaces",
      component: WorkspacesView,
    });
    host.addPage({
      path: "/workspaces/:workspaceId",
      title: "Workspace",
      component: WorkspacesView,
    });
    host.addPage({
      path: "/workspaces/:workspaceId/chats/:chatId",
      title: "Workspace",
      component: WorkspacesView,
    });
  },
};
