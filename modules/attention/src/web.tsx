import { type AgentsWeb, AgentsWebKey } from "@pi-spore/mod-agents/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import type {
  Approval,
  InboxChat,
  InboxItem,
  InboxWorkspace,
  Job,
  RunningItem,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  EmptyState,
  Notice,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  showToast,
  Textarea,
  usePhone,
} from "@pi-spore/ui";
import { Bell, CheckCheck, House } from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import {
  chatAsks,
  chatWaits,
  createInboxStore,
  type InboxStore,
  itemKey,
  notification,
} from "./inbox-store.js";
import { QuestionCard } from "./question-card.js";
import { type ApprovalViewProps, AttentionWebKey } from "./web-contract.js";

export * from "./web-contract.js";

/** Views of approval kinds, added by the modules that own them. */
const approvalViews = new Map<string, ComponentType<ApprovalViewProps>>();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleString();
}

let notificationFailureWarned = false;

function showNotification(item: InboxItem): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const { title, body } = notification(item);
  let shown: Notification;
  try {
    shown = new Notification(title, { body, tag: itemKey(item) });
  } catch (caught) {
    // Some phone browsers only allow notifications from a service worker. The inbox must still work.
    if (!notificationFailureWarned) {
      notificationFailureWarned = true;
      console.warn(`Desktop notification failed: ${message(caught)}`);
    }
    return;
  }
  shown.onclick = () => {
    window.focus();
    window.location.hash = "#/";
    shown.close();
  };
}

/** Where a chat opens: `#/workspaces/<workspace>/chats/<chat>`. */
const chatHref = (workspace: InboxWorkspace, chat: InboxChat) =>
  `#/workspaces/${workspace.id}/chats/${chat.id}`;

const DESKTOP_QUERY = "(hover: hover) and (pointer: fine)";

/** Where an item leads: the link of a notice, else its chat. */
const itemHref = (item: InboxItem) =>
  item.kind === "notice" ? item.href : chatHref(item.workspace, item.chat);

const TONES = {
  question: "warn",
  approval: "warn",
  dialog: "warn",
  failed: "fail",
  finished: "ok",
  notice: "warn",
} as const;

/**
 * Each new item makes one signal: a toast while the user looks at the page on a desktop, else a
 * notification. The chat on screen shows its own asks, so an item of it makes no signal at all while
 * the page is visible.
 */
function notifyItem(item: InboxItem, shownChat: () => string | undefined): void {
  if (
    item.kind !== "notice" &&
    item.chat.id === shownChat() &&
    document.visibilityState === "visible"
  ) {
    return;
  }
  if (!document.hasFocus()) {
    showNotification(item);
    return;
  }
  if (!window.matchMedia(DESKTOP_QUERY).matches) return;
  showToast({ ...notification(item), tone: TONES[item.kind], href: itemHref(item) });
}

/** The chat's name as Home shows it: its title, and what kind of chat it is when that is not the worker chat. */
function chatName(chat: InboxChat): string {
  const title = chat.title ?? "New chat";
  if (chat.kind === "side") return `${title} (side chat)`;
  if (chat.kind === "stage") return `${title} (pipeline stage)`;
  return chat.active ? title : `${title} (older chat)`;
}

/** A card's first line: the workspace, its project, the chat, and when the item came up. */
function Where({
  workspace,
  chat,
  at,
  children,
}: {
  workspace: InboxWorkspace;
  chat: InboxChat;
  at: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <a href={`#/workspaces/${workspace.id}`} className="font-semibold">
        {workspace.name}
      </a>
      <span className="text-muted">{workspace.projectName}</span>
      <a href={chatHref(workspace, chat)} className="max-w-64 truncate text-muted">
        {chatName(chat)}
      </a>
      {workspace.state !== "active" && <Chip>{workspace.state}</Chip>}
      {children}
      <span className="ml-auto text-xs text-muted" title={new Date(at).toLocaleString()}>
        {ago(at, Date.now())}
      </span>
    </div>
  );
}

/** The view for kinds without their own: what would happen, why, and the two choices. */
function PlainApprovalView({ approval, busy, approve, decline }: ApprovalViewProps) {
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-sm font-medium">{approval.title}</p>
      <p className="m-0 text-sm whitespace-pre-wrap">{approval.reason}</p>
      <DeclineNote note={note} onChange={setNote} />
      <div className="flex gap-2 max-md:flex-wrap">
        <Button variant="primary" disabled={busy} onClick={() => approve()}>
          Approve
        </Button>
        <Button disabled={busy} onClick={() => decline(note.trim() || undefined)}>
          Decline
        </Button>
      </div>
    </div>
  );
}

/** An optional note for the agent when the user declines. */
function DeclineNote({ note, onChange }: { note: string; onChange: (note: string) => void }) {
  return (
    <Textarea
      value={note}
      onChange={(event) => onChange(event.target.value)}
      placeholder="A note for the agent if you decline (optional)"
      aria-label="Note for the agent"
      rows={2}
    />
  );
}

function ApprovalCard({
  approval,
  onError,
}: {
  approval: Approval;
  onError: (text: string) => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const send = (path: string, body: unknown) => {
    setBusy(true);
    // On success the inbox drops the item; on failure the user can try again.
    api
      .send("POST", `attention/approvals/${approval.id}/${path}`, body)
      .catch((caught: unknown) => {
        onError(message(caught));
        setBusy(false);
      });
  };
  const View = approvalViews.get(approval.kind) ?? PlainApprovalView;
  return (
    <View
      approval={approval}
      busy={busy}
      approve={(subject) => send("approve", subject === undefined ? {} : { subject })}
      decline={(note) => send("decline", note === undefined ? {} : { note })}
    />
  );
}

const TITLES: Record<InboxItem["kind"], string> = {
  question: "Question",
  approval: "Approval",
  dialog: "Waiting for an answer",
  failed: "Agent failed",
  finished: "Finished, waits for you",
  notice: "Needs you",
};

/** An item a module added to Home (ADR 0155): a title, what is wrong, and a link to where to fix it. */
function NoticeCard({ item }: { item: Extract<InboxItem, { kind: "notice" }> }) {
  return (
    <Panel aria-label={`${TITLES.notice}: ${item.title}`}>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Chip tone={TONES.notice}>{TITLES.notice}</Chip>
          <span className="font-semibold">{item.title}</span>
          <span className="ml-auto text-xs text-muted" title={new Date(item.at).toLocaleString()}>
            {ago(item.at, Date.now())}
          </span>
        </div>
        {item.detail && <p className="m-0 text-sm text-muted">{item.detail}</p>}
        <div>
          <Button size="sm" asChild>
            <a href={itemHref(item)} className="no-underline">
              Open
            </a>
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function ItemCard({
  item,
  DialogCard,
  onError,
}: {
  item: Exclude<InboxItem, { kind: "notice" }>;
  DialogCard: AgentsWeb["DialogCard"];
  onError: (text: string) => void;
}) {
  const api = useApi();
  const call = (path: string, body?: unknown) =>
    api.send("POST", path, body).catch((caught: unknown) => onError(message(caught)));
  return (
    <Panel aria-label={`${TITLES[item.kind]}: ${item.workspace.name}`}>
      <div className="flex flex-col gap-3">
        <Where workspace={item.workspace} chat={item.chat} at={item.at}>
          <Chip tone={TONES[item.kind]}>{TITLES[item.kind]}</Chip>
        </Where>
        {item.kind === "question" && <QuestionCard question={item.question} onError={onError} />}
        {item.kind === "approval" && <ApprovalCard approval={item.approval} onError={onError} />}
        {item.kind === "dialog" && (
          <DialogCard
            dialog={item.dialog}
            onAnswer={(answer) =>
              void call(`agents/${item.agentId}/dialog`, { dialogId: item.dialog.id, ...answer })
            }
          />
        )}
        {item.kind === "failed" && (
          <pre className="m-0 max-h-40 overflow-auto rounded-lg bg-raised p-2 text-xs whitespace-pre-wrap">
            {item.error}
          </pre>
        )}
        {(item.kind === "failed" || item.kind === "finished") && (
          <div className="flex gap-2">
            <Button size="sm" asChild>
              <a href={itemHref(item)} className="no-underline">
                Open chat
              </a>
            </Button>
            {item.kind === "finished" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void call(`agents/${item.agentId}/seen`)}
              >
                Dismiss
              </Button>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** The chat's open questions and approvals above its composer: the same cards as Home, so an answer leaves both. */
function ChatAsks({ store, chatId }: { store: InboxStore; chatId: string }) {
  const inbox = useSyncExternalStore(store.subscribe, store.get);
  const [error, setError] = useState<string | undefined>();
  const asks = chatAsks(inbox, chatId);
  if (asks.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-3">
      {error && (
        <Notice tone="fail">
          <div className="flex items-start gap-2">
            <span className="flex-1">{error}</span>
            <Button size="sm" variant="ghost" onClick={() => setError(undefined)}>
              Dismiss
            </Button>
          </div>
        </Notice>
      )}
      {asks.map((item) => (
        <Panel key={itemKey(item)} aria-label={`${TITLES[item.kind]} from this chat`}>
          <div className="flex flex-col gap-3">
            <div>
              <Chip tone={TONES[item.kind]}>{TITLES[item.kind]}</Chip>
            </div>
            {item.kind === "question" ? (
              <QuestionCard question={item.question} onError={setError} />
            ) : (
              <ApprovalCard approval={item.approval} onError={setError} />
            )}
          </div>
        </Panel>
      ))}
    </div>
  );
}

const RUNNING_TEXT: Record<RunningItem["status"], string> = {
  busy: "Working",
  starting: "Starting",
  waiting: "Waiting for a free agent slot",
  helpers: "Working (helper running)",
  pipeline: "Working",
  idle: "Idle",
  stopped: "Stopped",
  failed: "Failed",
};

/** A restart stopped this job part way. Retry runs its step again; Cancel ends it. */
function InterruptedJob({ job, onError }: { job: Job; onError: (text: string) => void }) {
  const api = useApi();
  const call = (action: "retry" | "cancel") =>
    api
      .send("POST", `jobs/${job.id}/${action}`)
      .catch((caught: unknown) => onError(message(caught)));
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-semibold">{job.kind}</span>
        <span className="text-muted">step {job.step}</span>
        <span className="text-xs whitespace-nowrap text-muted">
          {ago(job.updatedAt, Date.now())}
        </span>
        <Button size="sm" onClick={() => void call("retry")}>
          Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void call("cancel")}>
          Cancel
        </Button>
      </div>
      {job.error && (
        <pre className="m-0 max-h-40 overflow-auto rounded-lg bg-raised p-2 text-xs whitespace-pre-wrap">
          {job.error}
        </pre>
      )}
    </li>
  );
}

/** Asks for permission only when the user clicks, never on load (R15.2). */
function NotificationButton() {
  const phone = usePhone();
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState(supported ? Notification.permission : "denied");
  if (phone || !supported) return null;
  if (permission === "granted") return <Chip tone="ok">Desktop notifications on</Chip>;
  if (permission === "denied")
    return (
      <Chip title="Allow notifications for this site in the browser settings">
        Notifications blocked
      </Chip>
    );
  return (
    <Button size="sm" onClick={() => void Notification.requestPermission().then(setPermission)}>
      <Bell />
      Turn on desktop notifications
    </Button>
  );
}

function makeHomePage(store: InboxStore, DialogCard: AgentsWeb["DialogCard"]) {
  return function HomePage() {
    const inbox = useSyncExternalStore(store.subscribe, store.get);
    const [error, setError] = useState<string | undefined>();
    return (
      <Page>
        <PageHeader title="Home">
          <NotificationButton />
        </PageHeader>
        {error && (
          <Notice tone="fail">
            <div className="flex items-start gap-2">
              <span className="flex-1">{error}</span>
              <Button size="sm" variant="ghost" onClick={() => setError(undefined)}>
                Dismiss
              </Button>
            </div>
          </Notice>
        )}
        {inbox === undefined && <p className="m-0 text-sm text-muted">Loading...</p>}
        {inbox && inbox.items.length === 0 && inbox.interrupted.length === 0 && (
          <EmptyState icon={CheckCheck} title="Nothing needs you">
            Questions, approvals, dialogs, failures, finished work, waiting PRs, due cards, and
            usage warnings show up here.
          </EmptyState>
        )}
        {inbox?.items.map((item) =>
          item.kind === "notice" ? (
            <NoticeCard key={itemKey(item)} item={item} />
          ) : (
            <ItemCard key={itemKey(item)} item={item} DialogCard={DialogCard} onError={setError} />
          ),
        )}
        {inbox && inbox.interrupted.length > 0 && (
          <Panel aria-label="Interrupted work">
            <PanelHeader title="Interrupted work" />
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {inbox.interrupted.map((job) => (
                <InterruptedJob key={job.id} job={job} onError={setError} />
              ))}
            </ul>
          </Panel>
        )}
        {inbox && inbox.running.length > 0 && (
          <Panel>
            <PanelHeader title="Running" />
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {inbox.running.map((run) => (
                <li key={run.agentId} className="flex items-center gap-2 text-sm max-md:flex-wrap">
                  <a
                    href={`#/workspaces/${run.workspace.id}`}
                    className="min-w-0 flex-1 truncate max-md:basis-full"
                  >
                    {run.workspace.name}
                  </a>
                  <span className="w-24 shrink-0 truncate text-muted max-md:w-auto">
                    {run.workspace.projectName}
                  </span>
                  <a
                    href={chatHref(run.workspace, run.chat)}
                    className="w-56 shrink-0 truncate text-muted max-md:w-auto max-md:max-w-full"
                  >
                    {chatName(run.chat)}
                  </a>
                  <Chip
                    tone={
                      run.status === "waiting" || (run.detail && run.status !== "pipeline")
                        ? "warn"
                        : "run"
                    }
                  >
                    {run.detail ?? RUNNING_TEXT[run.status]}
                  </Chip>
                  <span className="w-28 shrink-0 text-right text-xs whitespace-nowrap text-muted max-md:w-auto">
                    since {ago(run.since, Date.now())}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </Page>
    );
  };
}

export const attentionWeb: WebModule = {
  id: "attention",
  requires: ["agents"],
  core: true,
  setup(host) {
    const { DialogCard, addChatPanel, setUserWaits, shownChat } = host.use(AgentsWebKey);
    const store = createInboxStore(host.api, (item) => notifyItem(item, shownChat));
    setUserWaits(() => {
      const inbox = useSyncExternalStore(store.subscribe, store.get);
      return useMemo(() => chatWaits(inbox), [inbox]);
    });
    addChatPanel("attention", ({ chatId }) => <ChatAsks store={store} chatId={chatId} />);
    host.provide(AttentionWebKey, {
      addApprovalView: (kind, view) => {
        approvalViews.set(kind, view);
      },
      DeclineNote,
    });
    host.addPage({
      path: "/",
      title: "Home",
      rail: {
        order: 0,
        icon: House,
        useBadge: () => {
          const inbox = useSyncExternalStore(store.subscribe, store.get);
          return (inbox?.items.length ?? 0) + (inbox?.interrupted.length ?? 0);
        },
      },
      component: makeHomePage(store, DialogCard),
    });
  },
};
