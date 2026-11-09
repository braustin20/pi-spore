import {
  type ApprovalViewProps,
  type AttentionWeb,
  AttentionWebKey,
} from "@pi-spore/mod-attention/web";
import { type CreateWorkspaceFormProps, WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { type ApiClient, useApi, type WebModule } from "@pi-spore/module-api";
import {
  type BlockerRef,
  BoardEvent,
  CARD_COLUMNS,
  Card,
  type CardAuthor,
  type CardColumn,
  CardDetail,
  CardStartSubject,
  type CardStartTarget,
  COLUMN_TITLES,
  type CreateWorkspaceResponse,
  MODEL_TIERS,
  ModelChoices,
  type Project,
  ProjectList,
  parse,
  StartCardResponse,
  type Workspace,
  WorkspaceList,
} from "@pi-spore/shared";
import {
  Button,
  Checkbox,
  Chip,
  CollapsibleSection,
  type Confirm,
  EmptyState,
  Field,
  Input,
  ModelPicker,
  Notice,
  SectionLabel,
  Select,
  switchPane,
  Textarea,
  Tooltip,
  useConfirm,
  usePane,
  usePhone,
} from "@pi-spore/ui";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Lock,
  Plus,
  SquareKanban,
  Trash2,
  X,
} from "lucide-react";
import {
  type ComponentType,
  type DragEvent,
  type SubmitEvent,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Type from "typebox";
import {
  type BoardFilter,
  byColumn,
  dropIndex,
  dueState,
  filterCards,
  labelsOf,
  localDay,
  phoneColumn,
  type Step,
  stepTarget,
} from "./board.js";

const CardBody = Type.Object({ card: Card });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface BoardStore {
  subscribe(listener: () => void): () => void;
  /** Every card, or undefined before the first board arrives. */
  get(): Card[] | undefined;
}

/** Set in setup: one store for the page, the workspaces module's create form, and Home's decline note. */
let store: BoardStore | undefined;
let CreateForm: ComponentType<CreateWorkspaceFormProps> | undefined;
let DeclineNote: AttentionWeb["DeclineNote"] | undefined;

function useBoard(): Card[] | undefined {
  if (!store) throw new Error("The kanban web module is not set up");
  return useSyncExternalStore(store.subscribe, store.get);
}

/** One subscription to `kanban:board` for the whole page, shared by the board and the workspace panel. */
function createBoardStore(api: ApiClient): BoardStore {
  let cards: Card[] | undefined;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  const onEvent = (raw: unknown) => {
    try {
      cards = parse(BoardEvent, raw, "board event").cards;
    } catch (error) {
      console.error(`pi-spore: ${(error as Error).message}`);
      return;
    }
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      unsubscribe ??= api.subscribe("kanban:board", onEvent);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
    get: () => cards,
  };
}

/** Projects and workspaces, for names on cards and for the blocker list. */
function useLookups() {
  const api = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(() => {
    Promise.all([api.get("projects"), api.get("workspaces")])
      .then(([projectBody, workspaceBody]) => {
        setProjects(parse(ProjectList, projectBody, "project list").projects);
        setWorkspaces(parse(WorkspaceList, workspaceBody, "workspace list").workspaces);
      })
      .catch((caught: unknown) => setError(message(caught)));
  }, [api]);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  return { projects, workspaces, error, reload: load };
}

function DueChip({ card, today }: { card: Card; today: string }) {
  if (!card.due) return null;
  const state = dueState(card, today);
  return (
    <Chip mono tone={state === "overdue" ? "fail" : state === "today" ? "warn" : "neutral"}>
      {state === "overdue" ? `overdue ${card.due}` : state === "today" ? "due today" : card.due}
    </Chip>
  );
}

function blockerName(blocker: Card["blockedBy"][number]): string {
  return blocker.kind === "card" ? blocker.title : `workspace ${blocker.name}`;
}

const STEPS: { step: Step; label: string; Icon: ComponentType<{ className?: string }> }[] = [
  { step: "left", label: "Move to the previous column", Icon: ArrowLeft },
  { step: "up", label: "Move up", Icon: ArrowUp },
  { step: "down", label: "Move down", Icon: ArrowDown },
  { step: "right", label: "Move to the next column", Icon: ArrowRight },
];

function CardTile({
  card,
  project,
  selected,
  today,
  columns,
  onMove,
  onDragStart,
  onDropBefore,
}: {
  card: Card;
  project: string | undefined;
  selected: boolean;
  today: string;
  columns: Record<CardColumn, Card[]>;
  onMove: (card: Card, to: { column: CardColumn; index?: number }) => void;
  onDragStart: (card: Card) => void;
  onDropBefore: (event: DragEvent, target: Card) => void;
}) {
  const late = dueState(card, today) === "overdue";
  const open = card.blockedBy.filter((blocker) => blocker.open);
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", card.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(card);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDropBefore(event, card)}
      className={`group relative flex cursor-grab flex-col gap-1.5 rounded-lg border bg-raised px-3 py-2 ${
        selected ? "border-accent" : late ? "border-fail/60" : "border-line"
      }`}
    >
      <a
        href={`#/board/${card.id}`}
        className="text-sm font-medium text-fg [overflow-wrap:anywhere] hover:text-accent-strong"
      >
        {card.title}
      </a>
      <div className="flex flex-wrap items-center gap-1">
        {project && <Chip>{project}</Chip>}
        {card.labels.map((label) => (
          <Chip key={label} tone="accent">
            {label}
          </Chip>
        ))}
        <DueChip card={card} today={today} />
        {card.workspaceId && (
          <a href={`#/workspaces/${card.workspaceId}`} className="inline-flex">
            <Chip tone="run">workspace</Chip>
          </a>
        )}
        {(card.createdBy ?? card.changedBy) && (
          <Chip
            className="inline-flex items-center gap-1"
            title={card.createdBy ? "Added by an agent" : "Last changed by an agent"}
          >
            <Bot aria-hidden="true" className="size-3" />
            agent
          </Chip>
        )}
      </div>
      {open.length > 0 && (
        <div className="flex items-start gap-1 text-xs text-warn">
          <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <span>Blocked by {open.map(blockerName).join(", ")}</span>
        </div>
      )}
      {/* Buttons for keyboard and touch users; drag and drop does the same with a mouse. */}
      <div className="flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100">
        {STEPS.map(({ step, label, Icon }) => {
          const target = stepTarget(card, step, columns);
          return (
            <Tooltip key={step} label={label} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${label}: ${card.title}`}
                disabled={!target}
                onClick={() => target && onMove(card, target)}
              >
                <Icon />
              </Button>
            </Tooltip>
          );
        })}
      </div>
    </li>
  );
}

function ColumnView({
  column,
  cards,
  columns,
  projectName,
  selectedId,
  today,
  onMove,
}: {
  column: CardColumn;
  cards: Card[];
  columns: Record<CardColumn, Card[]>;
  projectName: (id: string | undefined) => string | undefined;
  selectedId: string | undefined;
  today: string;
  onMove: (card: Card, to: { column: CardColumn; index?: number }) => void;
}) {
  const [over, setOver] = useState(false);
  const dropped = (event: DragEvent, target: Card | undefined) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    const id = event.dataTransfer.getData("text/plain");
    const card = Object.values(columns)
      .flat()
      .find((candidate) => candidate.id === id);
    if (!card) return;
    onMove(card, { column, index: dropIndex(columns[column], id, target?.id) });
  };
  return (
    <section
      aria-label={COLUMN_TITLES[column]}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => dropped(event, undefined)}
      className={`flex w-72 shrink-0 flex-col max-md:w-full rounded-xl border bg-panel ${over ? "border-accent" : "border-line"}`}
    >
      <SectionLabel className="px-3 pt-3 pb-2">
        {COLUMN_TITLES[column]}
        <span className="font-mono">{cards.length}</span>
      </SectionLabel>
      <ul className="m-0 flex min-h-16 flex-1 list-none flex-col gap-2 overflow-y-auto p-2 pt-0">
        {cards.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            project={projectName(card.projectId)}
            selected={card.id === selectedId}
            today={today}
            columns={columns}
            onMove={onMove}
            onDragStart={() => {}}
            onDropBefore={dropped}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The model for work from a card (ADR 0120). The empty value is the default, named by `defaultLabel`. A value the
 * list does not hold (loading, failed) stays an option, so loading never changes the selection.
 */
function ModelSelect({
  value,
  onChange,
  defaultLabel,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  defaultLabel: string;
  disabled?: boolean;
}) {
  const api = useApi();
  const [choices, setChoices] = useState<ModelChoices>({ models: [] });
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (disabled) return;
    api
      .get("agents/models")
      .then((body) => setChoices(parse(ModelChoices, body, "models")))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, disabled]);

  const listed = choices.models.find((model) => `${model.provider}/${model.id}` === value);
  const label = value === "" ? defaultLabel : listed ? (listed.name ?? value) : value;
  return (
    <>
      <Field label="Model">
        <ModelPicker
          value={value}
          label={label}
          models={choices.models}
          tiers={MODEL_TIERS}
          onChange={onChange}
          defaultLabel={defaultLabel}
          tierError={choices.tierError}
          disabled={disabled}
          aria-label="Model"
        />
      </Field>
      {error && <Notice tone="warn">Could not load the model list: {error}.</Notice>}
    </>
  );
}

/** A start that sends no model uses the card's model, else the orchestrator setting. */
const startDefaultLabel = (card: Card | undefined) =>
  card?.model ? `Card's model (${card.model})` : "Default (orchestrator setting)";

/** A start in an existing workspace reuses its chat, which keeps its model (ADR 0120). */
function KeptModel() {
  return (
    <>
      <ModelSelect value="" onChange={() => {}} defaultLabel="The chat's current model" disabled />
      <p className="m-0 text-xs text-muted">This workspace's chat keeps its model.</p>
    </>
  );
}

/** Text field for labels: comma separated. */
const splitLabels = (text: string) =>
  text
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");

interface Draft {
  title: string;
  body: string;
  projectId: string;
  labels: string;
  due: string;
  model: string;
  blockedBy: BlockerRef[];
}

const draftOf = (card: Card | undefined): Draft => ({
  title: card?.title ?? "",
  body: card?.body ?? "",
  projectId: card?.projectId ?? "",
  labels: card?.labels.join(", ") ?? "",
  due: card?.due ?? "",
  model: card?.model ?? "",
  blockedBy: card?.blockedBy.map((blocker) => ({ kind: blocker.kind, id: blocker.id })) ?? [],
});

function BlockerPicker({
  value,
  onChange,
  cards,
  workspaces,
  selfId,
}: {
  value: BlockerRef[];
  onChange: (value: BlockerRef[]) => void;
  cards: readonly Card[];
  workspaces: readonly Workspace[];
  selfId: string | undefined;
}) {
  const nameOf = (ref: BlockerRef) =>
    ref.kind === "card"
      ? (cards.find((card) => card.id === ref.id)?.title ?? ref.id)
      : `Workspace: ${workspaces.find((workspace) => workspace.id === ref.id)?.name ?? ref.id}`;
  const taken = new Set(value.map((ref) => `${ref.kind}:${ref.id}`));
  const cardChoices = cards.filter(
    (card) => card.id !== selfId && card.column !== "done" && !taken.has(`card:${card.id}`),
  );
  const workspaceChoices = workspaces.filter(
    (workspace) => workspace.state !== "archived" && !taken.has(`workspace:${workspace.id}`),
  );
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {value.map((ref) => (
            <li key={`${ref.kind}:${ref.id}`}>
              <Chip className="inline-flex items-center gap-1">
                {nameOf(ref)}
                <button
                  type="button"
                  aria-label={`Remove blocker ${nameOf(ref)}`}
                  className="inline-flex cursor-pointer text-muted hover:text-fg"
                  onClick={() =>
                    onChange(
                      value.filter((other) => other.kind !== ref.kind || other.id !== ref.id),
                    )
                  }
                >
                  <X className="size-3" />
                </button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <Select
        aria-label="Add a blocker"
        value=""
        onChange={(event) => {
          const [kind, id] = event.target.value.split(":") as [BlockerRef["kind"], string];
          if (id) onChange([...value, { kind, id }]);
        }}
      >
        <option value="">Add a blocker...</option>
        {cardChoices.length > 0 && (
          <optgroup label="Cards">
            {cardChoices.map((card) => (
              <option key={card.id} value={`card:${card.id}`}>
                {card.title}
              </option>
            ))}
          </optgroup>
        )}
        {workspaceChoices.length > 0 && (
          <optgroup label="Workspaces">
            {workspaceChoices.map((workspace) => (
              <option key={workspace.id} value={`workspace:${workspace.id}`}>
                {workspace.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </div>
  );
}

const REASONS: Readonly<Record<string, string>> = {
  created: "created",
  manual: "moved",
  agent: "moved by an agent",
  "workspace-started": "workspace started",
  "workspace-archived": "workspace archived",
  "run-started": "run started",
};

/** Asks before a blocked card starts. True when it may start. */
async function confirmBlocked(card: Card, confirm: Confirm): Promise<boolean> {
  if (!card.blocked) return true;
  const names = card.blockedBy.filter((blocker) => blocker.open).map(blockerName);
  return confirm({
    title: "Card is blocked",
    message: `This card is blocked by: ${names.join(", ")}.\n\nStart it anyway?`,
    confirmLabel: "Start anyway",
  });
}

/** Active workspaces work from this card may start in: those of its project, or any without one. */
const startTargets = (card: Card, workspaces: readonly Workspace[]) =>
  workspaces.filter(
    (workspace) =>
      workspace.state === "active" &&
      (card.projectId === undefined || workspace.projectId === card.projectId),
  );

/**
 * Starts work from the card (R11.4, ADR 0100): in a new workspace with the usual create form, in an active
 * workspace of its project, or in a new run. The card's brief goes to the workspace's worker chat, or to the run's
 * coordinator chat.
 */
function StartWork({
  card,
  projects,
  workspaces,
  CreateForm,
  onDone,
}: {
  card: Card;
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  CreateForm: ComponentType<CreateWorkspaceFormProps>;
  onDone: () => void;
}) {
  const api = useApi();
  const [mode, setMode] = useState<"new" | "existing" | "run" | undefined>();
  const [confirmed, setConfirmed] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [started, setStarted] = useState<string | undefined>();
  const targets = startTargets(card, workspaces);
  const [workspaceId, setWorkspaceId] = useState("");
  const [model, setModel] = useState("");
  const [runProjectId, setRunProjectId] = useState("");
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { confirm, dialog } = useConfirm();

  if (started) {
    return (
      <div className="flex flex-col gap-2">
        {notes.map((note) => (
          <Notice key={note} tone="warn">
            {note}
          </Notice>
        ))}
        <Button size="sm" asChild>
          <a href={`#/workspaces/${started}`}>Open the workspace</a>
        </Button>
      </div>
    );
  }
  if (!mode) {
    const choose = async (next: "new" | "existing" | "run") => {
      if (!(await confirmBlocked(card, confirm))) return;
      setConfirmed(card.blocked);
      setMode(next);
    };
    return (
      <div className="flex flex-col gap-2">
        {dialog}
        <p className="m-0 text-xs text-muted">
          The card's brief goes to the workspace's worker chat, or to a run's coordinator chat. The
          chat starts on it.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void choose("new")}>
            Start in a new workspace
          </Button>
          <Button size="sm" disabled={targets.length === 0} onClick={() => void choose("existing")}>
            Start in an existing workspace
          </Button>
          <Button size="sm" onClick={() => void choose("run")}>
            Start a run
          </Button>
        </div>
      </div>
    );
  }
  const cancel = (
    <div>
      <Button size="sm" variant="ghost" onClick={() => setMode(undefined)}>
        Cancel
      </Button>
    </div>
  );
  if (mode === "existing") {
    const start = (event: SubmitEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(undefined);
      api
        .send("POST", `kanban/cards/${card.id}/start`, {
          workspaceId,
          ...(confirmed ? { confirmBlocked: true } : {}),
        })
        .then((body) => {
          onDone();
          window.location.hash = `#/workspaces/${parse(StartCardResponse, body, "start card").workspace.id}`;
        })
        .catch((caught: unknown) => {
          setError(message(caught));
          setBusy(false);
        });
    };
    return (
      <form onSubmit={start} className="flex flex-col gap-2">
        <Field label="Workspace">
          <Select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">Choose a workspace...</option>
            {targets.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </Select>
        </Field>
        <KeptModel />
        {error && <Notice tone="fail">{error}</Notice>}
        <div className="flex gap-1.5">
          <Button size="sm" variant="primary" type="submit" disabled={busy || workspaceId === ""}>
            Start here
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode(undefined)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  if (mode === "run") {
    const start = (event: SubmitEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(undefined);
      api
        .send("POST", `kanban/cards/${card.id}/start`, {
          run: true,
          ...(card.projectId === undefined ? { projectId: runProjectId } : {}),
          ...(base ? { base } : {}),
          ...(model ? { model } : {}),
          ...(confirmed ? { confirmBlocked: true } : {}),
        })
        .then((body) => {
          onDone();
          window.location.hash = `#/workspaces/${parse(StartCardResponse, body, "start card").workspace.id}`;
        })
        .catch((caught: unknown) => {
          setError(message(caught));
          setBusy(false);
        });
    };
    return (
      <form onSubmit={start} className="flex flex-col gap-2">
        {card.projectId === undefined && (
          <Field label="Project">
            <Select value={runProjectId} onChange={(event) => setRunProjectId(event.target.value)}>
              <option value="">Choose a project...</option>
              {projects
                .filter((project) => project.vcs === "git")
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="Base line">
          <Input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            placeholder="The project's current line"
          />
        </Field>
        <ModelSelect value={model} onChange={setModel} defaultLabel={startDefaultLabel(card)} />
        {error && <Notice tone="fail">{error}</Notice>}
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={busy || (card.projectId === undefined && runProjectId === "")}
          >
            Start run
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode(undefined)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  const submit: CreateWorkspaceFormProps["submit"] = async (request) => {
    const body = await api.send("POST", `kanban/cards/${card.id}/start`, {
      projectId: request.projectId,
      isolation: request.isolation,
      ...(request.line ? { line: request.line } : {}),
      ...(request.base ? { base: request.base } : {}),
      ...(model ? { model } : {}),
      ...(confirmed ? { confirmBlocked: true } : {}),
    });
    const { created } = parse(StartCardResponse, body, "start card");
    if (!created) throw new Error("The server started the card without a new workspace");
    return created;
  };
  const created = (result: CreateWorkspaceResponse) => {
    const found = [
      ...result.warnings,
      ...result.steps.filter((step) => !step.ok).map((step) => step.message),
    ];
    onDone();
    if (found.length === 0) {
      window.location.hash = `#/workspaces/${result.workspace.id}`;
      return;
    }
    setNotes(found);
    setStarted(result.workspace.id);
  };
  return (
    <div className="flex flex-col gap-2">
      <CreateForm
        key={card.id}
        title="Start a workspace for this card"
        projects={projects}
        projectId={card.projectId}
        lockProject={card.projectId !== undefined}
        name={card.title}
        submit={submit}
        onCreated={created}
      >
        <ModelSelect value={model} onChange={setModel} defaultLabel={startDefaultLabel(card)} />
      </CreateForm>
      {cancel}
    </div>
  );
}

/** Who made or last changed a card, when an agent did, with a link to its chat. */
function AuthorLine({
  label,
  author,
  workspaces,
}: {
  label: string;
  author: CardAuthor;
  workspaces: readonly Workspace[];
}) {
  const workspace = workspaces.find((candidate) => candidate.id === author.workspaceId);
  return (
    <p className="m-0 flex items-center gap-1 text-xs text-muted">
      <Bot aria-hidden="true" className="size-3" />
      {label} an agent in{" "}
      <a href={`#/workspaces/${author.workspaceId}/chats/${author.agentId}`}>
        {workspace?.name ?? "a removed workspace"}
      </a>
    </p>
  );
}

function CardEditor({
  cardId,
  cards,
  projects,
  workspaces,
  CreateForm,
  onLookupsChanged,
}: {
  cardId: string;
  cards: readonly Card[];
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  CreateForm: ComponentType<CreateWorkspaceFormProps>;
  onLookupsChanged: () => void;
}) {
  const api = useApi();
  const isNew = cardId === "new";
  const card = cards.find((candidate) => candidate.id === cardId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(card));
  const [preview, setPreview] = useState(!isNew && (card?.body ?? "") !== "");
  const [detail, setDetail] = useState<CardDetail | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { confirm, dialog } = useConfirm();

  // History changes on every move; read it again when the card does.
  const updatedAt = card?.updatedAt;
  useEffect(() => {
    if (isNew || updatedAt === undefined) return;
    api
      .get(`kanban/cards/${cardId}`)
      .then((body) => setDetail(parse(CardDetail, body, "card")))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, cardId, isNew, updatedAt]);

  if (!isNew && !card) {
    return (
      <EmptyState icon={SquareKanban} title="No such card">
        It may have been deleted.
      </EmptyState>
    );
  }

  const set = (fields: Partial<Draft>) => setDraft((current) => ({ ...current, ...fields }));

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const fields = {
      title: draft.title.trim(),
      body: draft.body,
      labels: splitLabels(draft.labels),
      blockedBy: draft.blockedBy,
    };
    const request = isNew
      ? api.send("POST", "kanban/cards", {
          ...fields,
          ...(draft.projectId ? { projectId: draft.projectId } : {}),
          ...(draft.due ? { due: draft.due } : {}),
          ...(draft.model ? { model: draft.model } : {}),
        })
      : api.send("PATCH", `kanban/cards/${cardId}`, {
          ...fields,
          projectId: draft.projectId || null,
          due: draft.due || null,
          model: draft.model || null,
        });
    request
      .then((body) => {
        const saved = parse(CardBody, body, "card").card;
        if (isNew) window.location.hash = `#/board/${saved.id}`;
        else setDraft(draftOf(saved));
      })
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false));
  };

  const remove = async () => {
    if (!card) return;
    const yes = await confirm({
      title: "Delete card?",
      message: `Delete the card "${card.title}"? Its history goes too.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    api
      .send("DELETE", `kanban/cards/${card.id}`)
      .then(() => {
        window.location.hash = "#/board";
      })
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false));
  };

  const moveTo = (column: CardColumn) => {
    if (!card) return;
    api
      .send("POST", `kanban/cards/${card.id}/move`, { column })
      .catch((caught: unknown) => setError(message(caught)));
  };

  const workspace = workspaces.find((candidate) => candidate.id === card?.workspaceId);
  const hasOpenWorkspace =
    card?.workspaceId !== undefined && workspace !== undefined && workspace.state !== "archived";

  return (
    <div className="flex flex-col">
      {dialog}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
        <Button variant="ghost" size="icon-sm" aria-label="Back" className="md:hidden" asChild>
          <a href="#/board">
            <ArrowLeft />
          </a>
        </Button>
        <SectionLabel className="flex-1">{isNew ? "New card" : "Card"}</SectionLabel>
        <Tooltip label="Close" side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close the card"
            className="max-md:hidden"
            asChild
          >
            <a href="#/board">
              <X />
            </a>
          </Button>
        </Tooltip>
      </div>
      <form onSubmit={save} className="flex flex-col gap-3 border-b border-line px-4 py-3">
        {card?.createdBy && (
          <AuthorLine label="Added by" author={card.createdBy} workspaces={workspaces} />
        )}
        {card?.changedBy && (
          <AuthorLine label="Last changed by" author={card.changedBy} workspaces={workspaces} />
        )}
        <Field label="Title">
          <Input
            value={draft.title}
            onChange={(event) => set({ title: event.target.value })}
            placeholder="Fix crafting UI"
            autoFocus={isNew}
          />
        </Field>
        {card && (
          <Field label="Column">
            <Select
              value={card.column}
              onChange={(event) => moveTo(event.target.value as CardColumn)}
            >
              {CARD_COLUMNS.map((column) => (
                <option key={column} value={column}>
                  {COLUMN_TITLES[column]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Project">
          <Select
            value={draft.projectId}
            onChange={(event) => set({ projectId: event.target.value })}
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Labels (comma separated)">
            <Input
              value={draft.labels}
              onChange={(event) => set({ labels: event.target.value })}
              placeholder="ui, bug"
            />
          </Field>
          <Field label="Due">
            <Input
              type="date"
              value={draft.due}
              onChange={(event) => set({ due: event.target.value })}
            />
          </Field>
        </div>
        <ModelSelect
          value={draft.model}
          onChange={(model) => set({ model })}
          defaultLabel="Default (orchestrator setting)"
        />
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="flex-1">Notes (Markdown)</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setPreview((current) => !current)}
            >
              {preview ? "Edit" : "Preview"}
            </Button>
          </div>
          {preview ? (
            <div className="md min-h-16 rounded-lg border border-line px-2.5 py-2 text-sm">
              {/* react-markdown skips raw HTML. */}
              <Markdown remarkPlugins={[remarkGfm]}>{draft.body || "_No notes._"}</Markdown>
            </div>
          ) : (
            <Textarea
              aria-label="Notes"
              rows={6}
              value={draft.body}
              onChange={(event) => set({ body: event.target.value })}
            />
          )}
        </div>
        <Field label="Blocked by">
          <BlockerPicker
            value={draft.blockedBy}
            onChange={(blockedBy) => set({ blockedBy })}
            cards={cards}
            workspaces={workspaces}
            selfId={card?.id}
          />
        </Field>
        {error && <Notice tone="fail">{error}</Notice>}
        <div className="flex gap-1.5">
          <Button variant="primary" type="submit" disabled={busy || draft.title.trim() === ""}>
            {isNew ? "Add card" : "Save"}
          </Button>
          {card && (
            <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>
              <Trash2 />
              Delete
            </Button>
          )}
        </div>
      </form>
      {card && (
        <CollapsibleSection title="Work">
          {hasOpenWorkspace ? (
            <p className="m-0 text-sm">
              Workspace <a href={`#/workspaces/${workspace.id}`}>{workspace.name}</a> (
              {workspace.state})
            </p>
          ) : (
            <StartWork
              card={card}
              projects={projects}
              workspaces={workspaces}
              CreateForm={CreateForm}
              onDone={onLookupsChanged}
            />
          )}
        </CollapsibleSection>
      )}
      {detail && (
        <CollapsibleSection title="History" defaultOpen={false}>
          <ol className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
            {detail.history.map((move) => (
              <li key={`${move.at}-${move.to}`} className="flex gap-2">
                <span className="font-mono text-muted">{new Date(move.at).toLocaleString()}</span>
                <span>
                  {REASONS[move.reason] ?? move.reason}: {COLUMN_TITLES[move.to]}
                </span>
              </li>
            ))}
          </ol>
        </CollapsibleSection>
      )}
    </div>
  );
}

function BoardPage({ params }: { params: Readonly<Record<string, string>> }) {
  const api = useApi();
  const all = useBoard();
  const { projects, workspaces, error: lookupError, reload } = useLookups();
  const [filter, setFilter] = useState<BoardFilter>({
    projectId: "",
    label: "",
    showArchived: false,
  });
  const [error, setError] = useState<string | undefined>();
  const selectedId = params.cardId;
  const today = localDay(new Date());
  const phone = usePhone();
  const pane = usePane();

  const cards = filterCards(all ?? [], filter);
  const columns = byColumn(cards);
  const shownColumns = phone ? [phoneColumn(pane, columns)] : CARD_COLUMNS;
  const projectName = (id: string | undefined) =>
    id === undefined
      ? undefined
      : (projects.find((project) => project.id === id)?.name ?? "removed project");

  const move = (card: Card, to: { column: CardColumn; index?: number }) => {
    // The index counts only the cards the filter shows; place it before the same neighbor among all cards.
    const shown = columns[to.column].filter((other) => other.id !== card.id);
    const neighbor = to.index === undefined ? undefined : shown[to.index];
    const full = byColumn(all ?? [])[to.column].filter((other) => other.id !== card.id);
    const index =
      to.index === undefined
        ? undefined
        : neighbor
          ? full.findIndex((other) => other.id === neighbor.id)
          : full.length;
    setError(undefined);
    api
      .send("POST", `kanban/cards/${card.id}/move`, {
        column: to.column,
        ...(index === undefined ? {} : { index }),
      })
      .catch((caught: unknown) => setError(message(caught)));
  };

  return (
    <div className={`flex h-full min-h-0 ${phone ? "relative" : ""}`}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-end gap-3 px-6 pt-5 pb-3 max-md:px-4">
          <h1 className="m-0 flex-1 text-xl font-semibold">Board</h1>
          <Field label="Project">
            <Select
              value={filter.projectId}
              onChange={(event) => setFilter({ ...filter, projectId: event.target.value })}
            >
              <option value="">All projects</option>
              <option value="none">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label">
            <Select
              value={filter.label}
              onChange={(event) => setFilter({ ...filter, label: event.target.value })}
            >
              <option value="">All labels</option>
              {labelsOf(all ?? []).map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {(all ?? []).some((card) => card.archivedAt !== undefined) && (
            <Checkbox
              label="Show archived"
              checked={filter.showArchived}
              onChange={(event) => setFilter({ ...filter, showArchived: event.target.checked })}
            />
          )}
          <Button variant="primary" asChild>
            <a href="#/board/new">
              <Plus />
              New card
            </a>
          </Button>
        </header>
        {(error ?? lookupError) && (
          <div className="px-6 pb-3 max-md:px-4">
            <Notice tone="fail">{error ?? lookupError}</Notice>
          </div>
        )}
        {all === undefined ? (
          <p className="m-0 px-6 text-sm text-muted max-md:px-4">Loading...</p>
        ) : (
          <>
            {phone && (
              <nav
                aria-label="Columns"
                className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none]"
              >
                {CARD_COLUMNS.map((column) => (
                  <Button
                    key={column}
                    size="sm"
                    variant={column === shownColumns[0] ? "primary" : "secondary"}
                    aria-pressed={column === shownColumns[0]}
                    className="shrink-0"
                    onClick={() => switchPane(column)}
                  >
                    {COLUMN_TITLES[column]} {columns[column].length}
                  </Button>
                ))}
              </nav>
            )}
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6 max-md:px-4 max-md:pb-4">
              {shownColumns.map((column) => (
                <ColumnView
                  key={column}
                  column={column}
                  cards={columns[column]}
                  columns={columns}
                  projectName={projectName}
                  selectedId={selectedId}
                  today={today}
                  onMove={move}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {selectedId && all !== undefined && (
        <aside
          aria-label="Card"
          className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel max-md:absolute max-md:inset-0 max-md:z-10 max-md:w-full max-md:border-l-0"
        >
          {/* Keyed by id, so a draft of one card does not carry over to the next. */}
          <CardEditor
            key={selectedId}
            cardId={selectedId}
            cards={all}
            projects={projects}
            workspaces={workspaces}
            CreateForm={CreateForm as ComponentType<CreateWorkspaceFormProps>}
            onLookupsChanged={reload}
          />
        </aside>
      )}
    </div>
  );
}

/** The workspace's card in the workspace view's right column. Renders nothing without one. */
function CardPanel({ workspace }: { workspace: Workspace }) {
  const all = useBoard();
  const card = all?.find((candidate) => candidate.workspaceId === workspace.id);
  if (!card) return null;
  const today = localDay(new Date());
  return (
    <CollapsibleSection title="Card">
      <div className="flex flex-col gap-1.5 text-sm">
        <a href={`#/board/${card.id}`} className="font-medium [overflow-wrap:anywhere]">
          {card.title}
        </a>
        <div className="flex flex-wrap gap-1">
          <Chip tone="accent">{COLUMN_TITLES[card.column]}</Chip>
          {card.labels.map((label) => (
            <Chip key={label}>{label}</Chip>
          ))}
          <DueChip card={card} today={today} />
        </div>
        {card.blocked && (
          <div className="flex items-start gap-1 text-xs text-warn">
            <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            <span>
              Blocked by{" "}
              {card.blockedBy
                .filter((blocker) => blocker.open)
                .map(blockerName)
                .join(", ")}
            </span>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** What a start target means, in words. */
function targetText(target: CardStartTarget, workspaces: readonly Workspace[]): string {
  if (target.kind === "existing") {
    const name = workspaces.find((workspace) => workspace.id === target.workspaceId)?.name;
    return `the workspace "${name ?? target.workspaceId}"`;
  }
  if (target.kind === "run") return "a new run";
  const how =
    target.isolation === "new"
      ? "a new worktree or copy"
      : target.isolation === "in-place"
        ? "the main checkout"
        : `the branch ${target.line ?? "(none given)"}`;
  return `a new workspace on ${how}`;
}

/**
 * A `card-start` approval on Home (ADR 0100): the card as it is now (blocked or not), the target the agent asked for,
 * its reason, and a choice of another target before approving.
 */
function CardStartView({ approval, busy, approve, decline }: ApprovalViewProps) {
  const all = useBoard();
  const { workspaces } = useLookups();
  const [note, setNote] = useState("");
  const subject = parse(CardStartSubject, approval.subject, "card-start approval");
  const card = all?.find((candidate) => candidate.id === subject.cardId);
  const asked = JSON.stringify(subject.target);
  const choices: { key: string; label: string; target: CardStartTarget }[] = [
    {
      key: asked,
      label: `As asked: ${targetText(subject.target, workspaces)}`,
      target: subject.target,
    },
    ...[
      { kind: "new", isolation: "new" } as const,
      { kind: "new", isolation: "in-place" } as const,
      { kind: "run" } as const,
      ...(card ? startTargets(card, workspaces) : []).map(
        (workspace) => ({ kind: "existing", workspaceId: workspace.id }) as const,
      ),
    ]
      .filter((target) => JSON.stringify(target) !== asked)
      .map((target) => ({
        key: JSON.stringify(target),
        label: targetText(target, workspaces),
        target,
      })),
  ];
  const [choice, setChoice] = useState(asked);
  // Not the card's model: the card may arrive later, and "" already means the card's model.
  const [model, setModel] = useState(subject.model ?? "");
  const chosen = choices.find((candidate) => candidate.key === choice) ?? choices[0];
  const existing = chosen?.target.kind === "existing";
  const Note = DeclineNote as AttentionWeb["DeclineNote"];
  return (
    <div className="flex flex-col gap-2.5 text-sm">
      {card ? (
        <div className="flex flex-col gap-1">
          <a href={`#/board/${card.id}`} className="font-medium [overflow-wrap:anywhere]">
            {card.title}
          </a>
          <div className="flex flex-wrap gap-1">
            <Chip tone="accent">{COLUMN_TITLES[card.column]}</Chip>
            {card.labels.map((label) => (
              <Chip key={label}>{label}</Chip>
            ))}
          </div>
          {card.blocked && (
            <div className="flex items-start gap-1 text-xs text-warn">
              <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
              <span>
                Blocked by{" "}
                {card.blockedBy
                  .filter((blocker) => blocker.open)
                  .map(blockerName)
                  .join(", ")}
                . Approve starts it anyway.
              </span>
            </div>
          )}
        </div>
      ) : (
        <Notice tone="warn">The card is gone. Decline this request.</Notice>
      )}
      <p className="m-0">
        <span className="text-muted">Reason: </span>
        <span className="whitespace-pre-wrap">{approval.reason}</span>
      </p>
      <Field label="Start in">
        <Select value={choice} onChange={(event) => setChoice(event.target.value)}>
          {choices.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {candidate.label}
            </option>
          ))}
        </Select>
      </Field>
      {existing ? (
        <KeptModel />
      ) : (
        <ModelSelect value={model} onChange={setModel} defaultLabel={startDefaultLabel(card)} />
      )}
      <Note note={note} onChange={setNote} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy || !card || !chosen}
          onClick={() => {
            if (!chosen) return;
            const sentModel = existing ? "" : model;
            approve(
              chosen.key === asked && sentModel === (subject.model ?? "")
                ? undefined
                : {
                    cardId: subject.cardId,
                    target: chosen.target,
                    ...(sentModel ? { model: sentModel } : {}),
                  },
            );
          }}
        >
          Approve and start
        </Button>
        <Button disabled={busy} onClick={() => decline(note.trim() || undefined)}>
          Decline
        </Button>
      </div>
    </div>
  );
}

export const kanbanWeb: WebModule = {
  id: "kanban",
  requires: ["workspaces", "attention"],
  core: false,
  setup(host) {
    store = createBoardStore(host.api);
    const attention = host.use(AttentionWebKey);
    DeclineNote = attention.DeclineNote;
    attention.addApprovalView("card-start", CardStartView);
    const view = host.use(WorkspaceViewKey);
    CreateForm = view.CreateForm;
    view.addPanel({ id: "kanban-card", order: 5, component: CardPanel });
    host.addPage({
      path: "/board",
      title: "Board",
      rail: { order: 5, icon: SquareKanban },
      component: BoardPage,
    });
    host.addPage({ path: "/board/:cardId", title: "Board", component: BoardPage });
  },
};
