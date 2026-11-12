import { type ApiClient, ApiRequestError, useApi, type WebModule } from "@pi-spore/module-api";
import {
  ArchiveWorkspaceResponse,
  type CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  type Isolation,
  type Project,
  ProjectLines,
  ProjectList,
  parse,
  type StepReport,
  Workspace,
} from "@pi-spore/shared";
import {
  Button,
  Checkbox,
  Chip,
  CollapsibleSection,
  type Confirm,
  closePane,
  cn,
  EmptyState,
  Field,
  Input,
  ListRow,
  Notice,
  openPane,
  Panel,
  PanelHeader,
  ResizeHandle,
  SectionLabel,
  Select,
  StatusLine,
  switchPane,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  useConfirm,
  usePane,
  usePhone,
  useStoredFlag,
  useStoredWidth,
  useWindowWidth,
} from "@pi-spore/ui";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Layers,
  Menu,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import { type ComponentType, type ReactNode, type SubmitEvent, useEffect, useState } from "react";
import Type from "typebox";
import { ago, groupByProject, type ProjectGroup, reduceWorkspaceList } from "./list.js";
import { defaultWidths, layoutPanels, type PanelSize, phonePane } from "./panel-layout.js";
import {
  type CreateWorkspaceFormProps,
  type UseWorkspaceStatus,
  type WorkspacePanel,
  type WorkspaceStatus,
  type WorkspaceTab,
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
const tabs: WorkspaceTab[] = [];
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

/** The notes to show after a create: warnings, copied files, and step results. */
const createdNotes = (result: CreateWorkspaceResponse): Note[] => [
  ...result.warnings.map((text) => ({ text })),
  ...(result.copied.length
    ? [{ text: `Copied into the worktree: ${result.copied.join(", ")}` }]
    : []),
  ...result.steps.map(stepNote),
];

function CreateForm({
  projects,
  projectId,
  lockProject = false,
  name: firstName = "",
  title = "Start a workspace",
  submit: send,
  onCreated,
  children,
}: CreateWorkspaceFormProps) {
  const api = useApi();
  const [chosen, setChosen] = useState(projectId ?? projects[0]?.id ?? "");
  const [name, setName] = useState(firstName);
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
    const request: CreateWorkspaceRequest = {
      projectId: project.id,
      name: name.trim(),
      isolation: mode,
      ...(mode === "existing" ? { line } : {}),
    };
    (send
      ? send(request)
      : api
          .send("POST", "workspaces", request)
          .then((body) => parse(CreateWorkspaceResponse, body, "create workspace"))
    )
      .then((result) => {
        setName("");
        onCreated(result);
      })
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <Panel className="w-full max-w-xl">
      <PanelHeader title={title} />
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Project">
          <Select
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
            disabled={lockProject}
          >
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
        {children}
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

/** Archives after a confirm. Returns the step notes, or undefined when the user says no. */
async function archiveWorkspace(
  api: ApiClient,
  confirm: Confirm,
  workspace: Workspace,
): Promise<Note[] | undefined> {
  const what =
    workspace.isolation === "in-place" ? "" : " Its copy will be removed; the branch stays.";
  const yes = await confirm({
    title: "Archive workspace?",
    message: `Archive "${workspace.name}"?${what}`,
    confirmLabel: "Archive",
    tone: "danger",
  });
  if (!yes) return undefined;
  const send = async (force: boolean) =>
    parse(
      ArchiveWorkspaceResponse,
      await api.send("POST", `workspaces/${workspace.id}/archive`, force ? { force } : {}),
      "archive",
    );
  try {
    return (await send(false)).steps.map(stepNote);
  } catch (caught) {
    // A failed step such as teardown answers `<step>_failed`; force skips it and any uncommitted-work check.
    const question =
      caught instanceof ApiRequestError && caught.code === "uncommitted_work"
        ? "Delete the uncommitted work and archive anyway?"
        : caught instanceof ApiRequestError && caught.code.endsWith("_failed")
          ? "Archive anyway? This also deletes any uncommitted work in the copy."
          : undefined;
    if (!question) throw caught;
    const force = await confirm({
      title: "Archive failed",
      message: `${(caught as Error).message}\n\n${question}`,
      confirmLabel: "Archive anyway",
      tone: "danger",
    });
    if (!force) return undefined;
    return (await send(true)).steps.map(stepNote);
  }
}

function WorkspaceRow({
  workspace,
  status,
  selected,
  chatId,
  now,
  onArchive,
}: {
  workspace: Workspace;
  status: WorkspaceStatus | undefined;
  selected: boolean;
  chatId: string | undefined;
  now: number;
  onArchive: () => void;
}) {
  const [open, setOpen] = useStoredFlag(`pi-spore.workspaces.chats.${workspace.id}`, false);
  const chats = status?.chats ?? [];
  // The buttons sit beside the row link, not in it: a button must not nest in an anchor.
  return (
    <div className="group relative">
      {/* The left padding is on every row, so names line up whether or not a row has a chats toggle. */}
      <ListRow
        href={`#/workspaces/${workspace.id}`}
        selected={selected}
        className="pl-8 max-md:pl-12"
      >
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted group-focus-within:invisible group-hover:invisible touch:invisible">
            {ago(workspace.updatedAt, now)}
          </span>
        </div>
        {workspace.line && (
          <div className="truncate font-mono text-xs text-muted">{workspace.line}</div>
        )}
        {status && (
          <StatusLine tone={status.tone} className="mt-0.5 max-w-full">
            {status.text}
          </StatusLine>
        )}
      </ListRow>
      {workspace.state !== "archived" && (
        <Tooltip label="Archive">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Archive ${workspace.name}`}
            className="absolute top-1.5 right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 touch:opacity-100"
            onClick={onArchive}
          >
            <X />
          </Button>
        </Tooltip>
      )}
      {chats.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} chats of ${workspace.name}`}
          className="absolute top-1 left-0.5 max-md:top-0 max-md:left-0"
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      )}
      {open && chats.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 py-0.5 pr-1 pl-8 max-md:pl-12">
          {chats.map((chat) => {
            const Icon = chat.icon;
            const current = chat.id === chatId;
            return (
              <li key={chat.id} className="min-w-0">
                <a
                  href={`#/workspaces/${workspace.id}/chats/${chat.id}`}
                  aria-current={current ? "page" : undefined}
                  title={`${chat.label}. ${chat.hint}`}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs no-underline hover:bg-raised/60 max-md:min-h-11",
                    current ? "bg-raised text-fg" : "text-muted",
                  )}
                >
                  <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{chat.label}</span>
                  {chat.working && (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-run animate-pulse"
                      />
                      <span className="sr-only">working</span>
                    </>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The answer of `POST /api/workspaces/planner`. */
const PlannerWorkspaceResponse = Type.Object({ workspace: Workspace });

/**
 * The project's Plan entry (ADR 0174). It links to the planner workspace, or makes it on the first click and then
 * opens it.
 */
function PlanRow({
  projectId,
  planner,
  selected,
  onError,
}: {
  projectId: string;
  planner: Workspace | undefined;
  selected: boolean;
  onError: (error: string | undefined) => void;
}) {
  const api = useApi();
  const make = () => {
    onError(undefined);
    api
      .send("POST", "workspaces/planner", { projectId })
      .then((body) => {
        const { workspace } = parse(PlannerWorkspaceResponse, body, "planner workspace");
        window.location.hash = `#/workspaces/${workspace.id}`;
      })
      .catch((caught: unknown) => onError(message(caught)));
  };
  return (
    <ListRow
      href={planner ? `#/workspaces/${planner.id}` : "#"}
      selected={selected}
      onClick={(event) => {
        if (planner) return;
        event.preventDefault();
        make();
      }}
    >
      <div className="flex items-center gap-2">
        <NotebookPen aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Plan</span>
        <span className="shrink-0 text-xs text-muted">Cards only</span>
      </div>
    </ListRow>
  );
}

function WorkspaceListColumn({
  workspaces,
  projects,
  selectedId,
  chatId,
  projectId,
  error,
  size,
  phone,
  onResize,
  onResetWidth,
  onCollapse,
  onArchive,
}: {
  workspaces: readonly Workspace[] | undefined;
  projects: readonly Project[];
  selectedId: string | undefined;
  chatId: string | undefined;
  projectId: string | undefined;
  error: string | undefined;
  size: PanelSize;
  phone: boolean;
  onResize: (width: number) => void;
  onResetWidth: () => void;
  onCollapse: () => void;
  onArchive: (workspace: Workspace) => void;
}) {
  const [showArchived, setShowArchived] = useStoredFlag("pi-spore.workspaces.archived", false);
  const [planError, setPlanError] = useState<string | undefined>();
  const statuses = useStatus(workspaces ?? []);
  const projectName = (id: string) => projects.find((candidate) => candidate.id === id)?.name ?? id;
  const groups = groupByProject(workspaces ?? [], projects, { showArchived, projectId });
  const now = Date.now();
  return (
    <aside
      aria-label="Workspaces"
      style={{ width: phone ? "min(20rem, 85vw)" : size.width }}
      className={cn(
        "relative flex shrink-0 flex-col border-r border-line bg-panel",
        phone && "absolute inset-y-0 left-0 z-30 shadow-lg",
      )}
    >
      {!phone && (
        <ResizeHandle
          label="Resize the workspace list"
          {...size}
          grow={1}
          onChange={onResize}
          onReset={onResetWidth}
        />
      )}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
        <SectionLabel className="flex-1">Workspaces</SectionLabel>
        <Tooltip label="New workspace" side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label="New workspace" asChild>
            <a href={projectId ? `#/workspaces/in/${projectId}` : "#/workspaces"}>
              <Plus />
            </a>
          </Button>
        </Tooltip>
        {phone ? (
          <Button variant="ghost" size="icon-sm" aria-label="Close the list" onClick={closePane}>
            <X />
          </Button>
        ) : (
          <Tooltip label="Hide the list" side="bottom">
            <Button variant="ghost" size="icon-sm" aria-label="Hide the list" onClick={onCollapse}>
              <PanelLeftClose />
            </Button>
          </Tooltip>
        )}
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
        {(error ?? planError) && <Notice tone="fail">{error ?? planError}</Notice>}
        {workspaces === undefined && !error && (
          <p className="px-2 text-sm text-muted">Loading...</p>
        )}
        {workspaces !== undefined && groups.length === 0 && (
          <p className="px-2 text-sm text-muted">No workspaces.</p>
        )}
        {groups.map((group, index) => (
          <ProjectGroupView
            key={group.projectId}
            group={group}
            first={index === 0}
            selectedId={selectedId}
            chatId={chatId}
            statuses={statuses}
            now={now}
            onPlanError={setPlanError}
            onArchive={onArchive}
          />
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

/**
 * One project's block in the list: its heading, its Plan entry, and its workspaces by state. With several projects
 * showing, the heading folds the block to just its name and a count; the choice is stored per project.
 */
function ProjectGroupView({
  group,
  first,
  selectedId,
  chatId,
  statuses,
  now,
  onPlanError,
  onArchive,
}: {
  group: ProjectGroup;
  first: boolean;
  selectedId: string | undefined;
  chatId: string | undefined;
  statuses: ReadonlyMap<string, WorkspaceStatus>;
  now: number;
  onPlanError: (error: string | undefined) => void;
  onArchive: (workspace: Workspace) => void;
}) {
  const [collapsed, setCollapsed] = useStoredFlag(
    `pi-spore.workspaces.collapsed.${group.projectId}`,
    false,
  );
  // One group, or the list filtered to one project: no heading, so nothing to fold.
  const open = !(group.divider && collapsed);
  const count = group.parts.reduce((total, part) => total + part.workspaces.length, 0);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and min-width that fight the list layout
    <div role="group" aria-label={group.name} className="flex flex-col gap-4">
      {group.divider && (
        <SectionLabel
          role="heading"
          aria-level={2}
          className={cn("px-3", !first && "border-t border-line pt-3")}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-label={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
            onClick={() => setCollapsed(!collapsed)}
            className="flex cursor-pointer items-center gap-1.5 uppercase hover:text-fg"
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            )}
            {group.name}
            {collapsed && <span className="font-mono">{count}</span>}
          </button>
        </SectionLabel>
      )}
      {open && group.plan && (
        <PlanRow
          projectId={group.projectId}
          planner={group.planner}
          selected={group.planner !== undefined && group.planner.id === selectedId}
          onError={onPlanError}
        />
      )}
      {open &&
        group.parts.map((part) => (
          <section key={part.state} aria-label={part.label} className="flex flex-col gap-0.5">
            <SectionLabel className="px-3 pb-1">
              {part.label}
              <span className="font-mono">{part.workspaces.length}</span>
            </SectionLabel>
            {part.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                status={statuses.get(workspace.id)}
                selected={workspace.id === selectedId}
                chatId={chatId}
                now={now}
                onArchive={() => onArchive(workspace)}
              />
            ))}
          </section>
        ))}
    </div>
  );
}

/** What the workspace is, and rename, park, resume, and archive. */
function Details({
  workspace,
  project,
  onNotes,
}: {
  workspace: Workspace;
  project: Project | undefined;
  onNotes: (notes: Note[]) => void;
}) {
  const api = useApi();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  const act = (promise: Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    return promise
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
    setBusy(true);
    setError(undefined);
    try {
      const notes = await archiveWorkspace(api, confirm, workspace);
      if (notes) onNotes(notes);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const stateTone =
    workspace.state === "active" ? "ok" : workspace.state === "parked" ? "warn" : "neutral";
  return (
    <CollapsibleSection title="Workspace">
      {dialog}
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

/** "Details", then the module tabs in their order. */
function orderedTabs(): { id: string; title: string }[] {
  return [
    { id: "details", title: "Details" },
    ...[...tabs].sort((a, b) => a.order - b.order).map(({ id, title }) => ({ id, title })),
  ];
}

function RightColumn({
  workspace,
  project,
  tab,
  onTab,
  size,
  phone,
  onResize,
  onResetWidth,
  onNotes,
  onCollapse,
}: {
  workspace: Workspace;
  project: Project | undefined;
  tab: string;
  onTab: (tab: string) => void;
  size: PanelSize;
  phone: boolean;
  onResize: (width: number) => void;
  onResetWidth: () => void;
  onNotes: (notes: Note[]) => void;
  onCollapse: () => void;
}) {
  const sortedTabs = [...tabs].sort((a, b) => a.order - b.order);
  return (
    <aside
      aria-label="Workspace details"
      style={phone ? undefined : { width: size.width }}
      className={cn(
        "relative flex shrink-0 flex-col border-l border-line bg-panel",
        phone && "absolute inset-0 z-40 border-l-0",
      )}
    >
      {!phone && (
        <ResizeHandle
          label="Resize the details"
          {...size}
          grow={-1}
          onChange={onResize}
          onReset={onResetWidth}
        />
      )}
      <Tabs value={tab} onValueChange={onTab} className="min-h-0 flex-1">
        <div
          className={cn(
            "flex h-11 shrink-0 items-end border-b border-line pr-2",
            phone && "items-center pl-1",
          )}
        >
          {phone && (
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={closePane}>
              <ArrowLeft />
            </Button>
          )}
          <TabsList
            className={cn(
              "min-w-0 flex-1 overflow-x-auto border-b-0",
              phone && "[scrollbar-width:none]",
            )}
          >
            <TabsTrigger value="details">Details</TabsTrigger>
            {sortedTabs.map((extra) => (
              <TabsTrigger key={extra.id} value={extra.id}>
                {extra.title}
              </TabsTrigger>
            ))}
          </TabsList>
          {!phone && (
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
          )}
        </div>
        <TabsContent value="details" className="overflow-y-auto">
          {/* Keyed by id, so a rename or error of one workspace does not carry over to the next. */}
          <Details key={workspace.id} workspace={workspace} project={project} onNotes={onNotes} />
          {[...panels]
            .sort((a, b) => a.order - b.order)
            .map((panel) => (
              <panel.component key={panel.id} workspace={workspace} />
            ))}
        </TabsContent>
        {sortedTabs.map((extra) => (
          <TabsContent key={extra.id} value={extra.id} className="flex flex-col">
            <extra.component key={workspace.id} workspace={workspace} />
          </TabsContent>
        ))}
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
  const { confirm, dialog } = useConfirm();
  const [listOpen, setListOpen] = useStoredFlag("pi-spore.workspaces.list", true);
  const [rightOpen, setRightOpen] = useStoredFlag(
    "pi-spore.workspaces.details",
    window.innerWidth >= 1100,
  );
  const windowWidth = useWindowWidth();
  const defaults = defaultWidths(windowWidth);
  const [listWidth, setListWidth] = useStoredWidth("pi-spore.workspaces.list-width", defaults.list);
  const [rightWidth, setRightWidth] = useStoredWidth(
    "pi-spore.workspaces.details-width",
    defaults.right,
  );
  const [tab, setTab] = useState("details");
  const phone = usePhone();
  const pane = usePane();

  useEffect(() => {
    api
      .get("projects")
      .then((body) => setProjects(parse(ProjectList, body, "project list").projects))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api]);

  useEffect(
    () =>
      api.subscribe("workspaces:list", (event) => {
        setWorkspaces((current) => reduceWorkspaceList(current ?? [], event));
      }),
    [api],
  );

  // Notes belong to the workspace they were made for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clears on selection change only
  useEffect(() => setNotes([]), [selectedId]);

  const workspace = workspaces?.find((candidate) => candidate.id === selectedId);
  const project = projects.find((candidate) => candidate.id === workspace?.projectId);
  // A planner workspace is chat only: no details column and no tabs (ADR 0174).
  const details = workspace !== undefined && !workspace.planner;
  const paneTabs = details ? orderedTabs() : [];
  const shown = phone
    ? phonePane({
        pane,
        tabIds: paneTabs.map((candidate) => candidate.id),
        hasWorkspace: workspace !== undefined,
      })
    : "main";
  const wide = tabs.find((candidate) => candidate.id === tab)?.wide === true;
  const layout = layoutPanels({
    window: windowWidth,
    list: listOpen ? listWidth : "closed",
    right: !details ? "absent" : rightOpen ? rightWidth : "closed",
    wide,
  });

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
          onCreated={(result) => {
            window.location.hash = `#/workspaces/${result.workspace.id}`;
            // After the hash change, so the selection change does not clear them.
            setTimeout(() => setNotes(createdNotes(result)), 0);
          }}
        />
      </div>
    );
  }

  const listColumn = (
    <WorkspaceListColumn
      workspaces={workspaces}
      projects={projects}
      selectedId={selectedId}
      chatId={params.chatId}
      projectId={projectId}
      error={error}
      size={layout.list}
      phone={phone}
      onResize={setListWidth}
      onResetWidth={() => setListWidth(defaults.list)}
      onCollapse={() => setListOpen(false)}
      onArchive={(target) =>
        void archiveWorkspace(api, confirm, target).then(
          (result) => result && setNotes(result),
          (caught: unknown) => setNotes([{ text: message(caught), error: true }]),
        )
      }
    />
  );

  return (
    <div className={cn("flex h-full min-h-0", phone && "relative")}>
      {dialog}
      {!phone &&
        (listOpen ? (
          listColumn
        ) : (
          <CollapsedColumn label="Show the list" side="left" onExpand={() => setListOpen(true)} />
        ))}
      <div className="flex min-w-0 flex-1 flex-col">
        {phone && (
          <div
            data-hide-while-typing
            className="flex h-11 shrink-0 items-center border-b border-line"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Workspaces"
              onClick={() => openPane("list")}
            >
              <Menu />
            </Button>
            {workspace && (
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pr-2 [scrollbar-width:none]">
                {paneTabs.map((candidate) => (
                  <Button
                    key={candidate.id}
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openPane(candidate.id)}
                  >
                    {candidate.title}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
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
      {phone && shown === "list" && (
        <>
          <button
            type="button"
            aria-label="Close the list"
            className="absolute inset-0 z-20 bg-bg/60"
            onClick={closePane}
          />
          {listColumn}
        </>
      )}
      {phone && workspace && details && typeof shown === "object" && (
        <RightColumn
          workspace={workspace}
          project={project}
          tab={shown.tab}
          onTab={switchPane}
          size={layout.right}
          phone
          onResize={setRightWidth}
          onResetWidth={() => setRightWidth(defaults.right)}
          onNotes={setNotes}
          onCollapse={() => setRightOpen(false)}
        />
      )}
      {!phone &&
        workspace &&
        details &&
        (rightOpen ? (
          <RightColumn
            workspace={workspace}
            project={project}
            tab={tab}
            onTab={setTab}
            size={layout.right}
            phone={false}
            onResize={setRightWidth}
            onResetWidth={() => setRightWidth(defaults.right)}
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
      addTab: (tab) => {
        if (tab.id === "details" || tabs.some((existing) => existing.id === tab.id))
          throw new Error(`Workspace tab "${tab.id}" is added twice`);
        tabs.push(tab);
      },
      setMain: (component) => {
        if (Main) throw new Error("The workspace main pane is set twice");
        Main = component;
      },
      setStatus: (hook) => {
        if (useStatus !== noStatus) throw new Error("The workspace status source is set twice");
        useStatus = hook;
      },
      CreateForm,
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
