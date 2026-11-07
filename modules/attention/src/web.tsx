import { type AgentsWeb, AgentsWebKey } from "@pi-spore/mod-agents/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import type { InboxItem, InboxWorkspace, Question, RunningItem } from "@pi-spore/shared";
import {
  Button,
  Chip,
  EmptyState,
  Notice,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Textarea,
} from "@pi-spore/ui";
import { Bell, CheckCheck, House } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { createInboxStore, type InboxStore, itemKey, notification } from "./inbox-store.js";

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

function showNotification(item: InboxItem): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.hasFocus()) return;
  const { title, body } = notification(item);
  const shown = new Notification(title, { body, tag: itemKey(item) });
  shown.onclick = () => {
    window.focus();
    window.location.hash = "#/";
    shown.close();
  };
}

/** A card's first line: the workspace, its project, and when the item came up. */
function Where({
  workspace,
  at,
  children,
}: {
  workspace: InboxWorkspace;
  at: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <a href={`#/workspaces/${workspace.id}`} className="font-semibold">
        {workspace.name}
      </a>
      <span className="text-muted">{workspace.projectName}</span>
      {workspace.state !== "active" && <Chip>{workspace.state}</Chip>}
      {children}
      <span className="ml-auto text-xs text-muted" title={new Date(at).toLocaleString()}>
        {ago(at, Date.now())}
      </span>
    </div>
  );
}

function QuestionCard({
  question,
  onError,
}: {
  question: Question;
  onError: (text: string) => void;
}) {
  const api = useApi();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const answer = (value: string) => {
    setSending(true);
    api
      .send("POST", `attention/questions/${question.id}/answer`, { answer: value })
      .catch((caught: unknown) => {
        onError(message(caught));
        setSending(false);
      });
  };
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-sm whitespace-pre-wrap">{question.question}</p>
      {question.choices && (
        <div className="flex flex-col gap-1.5">
          {question.choices.map((choice, index) => (
            <button
              key={choice}
              type="button"
              disabled={sending}
              onClick={() => answer(choice)}
              className="flex cursor-pointer items-baseline gap-2.5 rounded-lg border border-line bg-raised px-3 py-2 text-left text-sm text-fg hover:border-accent disabled:cursor-default disabled:opacity-60"
            >
              <span className="font-mono text-xs text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1">{choice}</span>
            </button>
          ))}
        </div>
      )}
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={question.choices ? "Or answer in your own words" : "Your answer"}
        aria-label="Your answer"
        rows={2}
      />
      <div>
        <Button
          variant="primary"
          disabled={sending || text.trim() === ""}
          onClick={() => answer(text.trim())}
        >
          Send answer
        </Button>
      </div>
    </div>
  );
}

const TITLES: Record<InboxItem["kind"], string> = {
  question: "Question",
  dialog: "Waiting for an answer",
  failed: "Agent failed",
  finished: "Finished, waits for you",
};

const TONES = { question: "warn", dialog: "warn", failed: "fail", finished: "ok" } as const;

function ItemCard({
  item,
  DialogCard,
  onError,
}: {
  item: InboxItem;
  DialogCard: AgentsWeb["DialogCard"];
  onError: (text: string) => void;
}) {
  const api = useApi();
  const call = (path: string, body?: unknown) =>
    api.send("POST", path, body).catch((caught: unknown) => onError(message(caught)));
  return (
    <Panel aria-label={`${TITLES[item.kind]}: ${item.workspace.name}`}>
      <div className="flex flex-col gap-3">
        <Where workspace={item.workspace} at={item.at}>
          <Chip tone={TONES[item.kind]}>{TITLES[item.kind]}</Chip>
        </Where>
        {item.kind === "question" && <QuestionCard question={item.question} onError={onError} />}
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
              <a href={`#/workspaces/${item.workspace.id}`} className="no-underline">
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

const RUNNING_TEXT: Record<RunningItem["status"], string> = {
  busy: "Working",
  starting: "Starting",
  waiting: "Waiting for a free agent slot",
  idle: "Idle",
  stopped: "Stopped",
  failed: "Failed",
};

/** Asks for permission only when the user clicks, never on load (R15.2). */
function NotificationButton() {
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState(supported ? Notification.permission : "denied");
  if (!supported) return null;
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
        {inbox && inbox.items.length === 0 && (
          <EmptyState icon={CheckCheck} title="Nothing needs you">
            Questions, dialogs, failures, and finished work from every workspace show up here.
          </EmptyState>
        )}
        {inbox?.items.map((item) => (
          <ItemCard key={itemKey(item)} item={item} DialogCard={DialogCard} onError={setError} />
        ))}
        {inbox && inbox.running.length > 0 && (
          <Panel>
            <PanelHeader title="Running" />
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {inbox.running.map((run) => (
                <li key={run.agentId} className="flex items-center gap-2 text-sm">
                  <a href={`#/workspaces/${run.workspace.id}`}>{run.workspace.name}</a>
                  <span className="text-muted">{run.workspace.projectName}</span>
                  <Chip tone={run.status === "waiting" ? "warn" : "run"}>
                    {RUNNING_TEXT[run.status]}
                  </Chip>
                  <span className="ml-auto text-xs text-muted">
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
    const store = createInboxStore(host.api, showNotification);
    const { DialogCard } = host.use(AgentsWebKey);
    host.addPage({
      path: "/",
      title: "Home",
      rail: {
        order: 0,
        icon: House,
        useBadge: () => useSyncExternalStore(store.subscribe, store.get)?.items.length ?? 0,
      },
      component: makeHomePage(store, DialogCard),
    });
  },
};
