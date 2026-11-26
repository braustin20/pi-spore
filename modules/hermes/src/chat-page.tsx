/**
 * The Hermes page (ADR 0202, card Hermes 2.1): the connector status, the profile's sessions, a chat with one
 * pi-spore-owned session, and, with no session open, the handoffs of card Hermes 1.2. The browser talks only to
 * pi-spore; it never sees the Hermes key.
 */
import { type ApiClient, useApi } from "@pi-spore/module-api";
import {
  type HermesChatEvent,
  HermesChatMessages,
  type HermesChatRun,
  type HermesChatSession,
  HermesChatSessionList,
  HermesRunFacts,
  HermesStatus,
  ProjectList,
  parse,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  cn,
  EmptyState,
  Field,
  Input,
  ListRow,
  Markdown,
  Notice,
  Page,
  PageHeader,
  Select,
  Textarea,
  type Tone,
} from "@pi-spore/ui";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ControlRow, Handoffs, Reconcile } from "./handoffs-page.js";

/** How often the status is read again. The server answers from its cache, so this sends Hermes nothing. */
export const STATUS_MS = 5_000;
/** Messages per page of the stored transcript. */
const PAGE = 100;

const STATUS_TONE: Record<HermesStatus["state"], Tone> = {
  disabled: "neutral",
  unreachable: "warn",
  unauthorized: "fail",
  incompatible: "fail",
  ready: "ok",
};
const RUN_TONE: Record<HermesChatRun["state"], Tone> = {
  sending: "warn",
  queued: "neutral",
  running: "neutral",
  waiting_for_approval: "warn",
  unknown: "warn",
  completed: "ok",
  cancelled: "neutral",
  failed: "fail",
  interrupted: "neutral",
};
const ENDED = new Set<HermesChatRun["state"]>([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
  "unknown",
]);

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** The connector status, shared by the rail entry and the page. */
export interface StatusStore {
  subscribe(listener: () => void): () => void;
  get(): HermesStatus | undefined;
}

/** Reads `hermes/status` while anything listens, every `STATUS_MS`. */
export function createStatusStore(api: ApiClient): StatusStore {
  let status: HermesStatus | undefined;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const read = () =>
    api
      .get("hermes/status")
      .then((body) => {
        const next = parse(HermesStatus, body, "Hermes status");
        if (JSON.stringify(next) === JSON.stringify(status)) return;
        status = next;
        for (const listener of listeners) listener();
      })
      .catch(() => undefined);
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void read();
        timer = setInterval(read, STATUS_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) clearInterval(timer);
      };
    },
    get: () => status,
  };
}

function StatusLine({ status }: { status: HermesStatus }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          Profile {status.state === "ready" ? status.profile : "unknown"}
        </span>
        <Chip tone={STATUS_TONE[status.state]}>{status.state}</Chip>
      </div>
      {status.state === "ready" && <span className="text-muted">Hermes {status.version}</span>}
      {"detail" in status && <span className="break-words text-muted">{status.detail}</span>}
    </div>
  );
}

function NewSession({
  profile,
  onMade,
}: {
  profile: string;
  onMade: (session: HermesChatSession) => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (!open) return;
    api
      .get("projects")
      .then((body) => setProjects(parse(ProjectList, body, "projects").projects))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, open]);
  if (!open)
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        New session
      </Button>
    );
  const make = async () => {
    setError(undefined);
    try {
      const body = (await api.send("POST", "hermes/chat/sessions", {
        title,
        ...(projectId ? { projectId } : {}),
      })) as { session: HermesChatSession };
      setOpen(false);
      setTitle("");
      setProjectId("");
      onMade(body.session);
    } catch (caught) {
      setError(message(caught));
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3 text-sm">
      <p className="m-0">
        A new conversation with the Hermes profile {profile}. It is not Homelab Maintainer and does
        not share its memory.
      </p>
      <Field label="Title">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Project (optional)">
        <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">None</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
      </Field>
      {error && <Notice tone="fail">{error}</Notice>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!title.trim()} onClick={() => void make()}>
          Create
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SessionRow({ session, selected }: { session: HermesChatSession; selected: boolean }) {
  return (
    <ListRow href={`#/hermes/${encodeURIComponent(session.id)}`} selected={selected}>
      <span className="block truncate text-sm">{session.title ?? session.id}</span>
      <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
        {session.kind === "handoff" && <Chip tone="neutral">handoff</Chip>}
        {session.readOnly ?? "Yours: you can send here"}
      </span>
    </ListRow>
  );
}

const roleLabel: Record<string, string> = { user: "You", assistant: "Hermes", tool: "Tool" };

/** A stored message. Roles other than user, assistant, and tool (such as `session_meta`) are not shown. */
function StoredMessage({ entry }: { entry: HermesChatMessages["messages"][number] }) {
  const label = roleLabel[entry.role];
  if (!label) return null;
  if (entry.role === "tool")
    return (
      <div className="text-xs text-muted">
        Tool {entry.tool ?? ""}: <span className="break-words">{entry.content?.slice(0, 200)}</span>
      </div>
    );
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg px-3 py-2",
        entry.role === "user" ? "self-end bg-raised" : "",
      )}
    >
      <span className="text-xs font-medium text-muted">{label}</span>
      {entry.content && <Markdown text={entry.content} />}
    </div>
  );
}

/** One run sent from the page. The server publishes every change, so the block needs no reload. */
function RunBlock({ run }: { run: HermesChatRun }) {
  const api = useApi();
  const [error, setError] = useState<string | undefined>();
  const post = async (path: string, body: unknown = {}) => {
    setError(undefined);
    try {
      await api.send("POST", `hermes/chat/runs/${run.id}/${path}`, body);
    } catch (caught) {
      setError(message(caught));
    }
  };
  const live = !ENDED.has(run.state);
  return (
    <div className="flex flex-col gap-2 border-l-2 border-line pl-3 text-sm">
      {live && (
        <div className="flex flex-col gap-1 self-end rounded-lg bg-raised px-3 py-2">
          <span className="text-xs font-medium text-muted">You</span>
          <span className="break-words whitespace-pre-wrap">{run.input}</span>
        </div>
      )}
      {run.tools.map((tool, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tools only grow, in order.
        <div key={index} className="flex min-w-0 items-center gap-2 text-xs">
          <Chip tone={tool.state === "failed" ? "fail" : tool.state === "done" ? "ok" : "neutral"}>
            {tool.state}
          </Chip>
          <code className="min-w-0 truncate">
            {tool.name}
            {tool.preview ? `: ${tool.preview}` : ""}
          </code>
        </div>
      ))}
      {run.text && (live || run.state !== "completed") && <Markdown text={run.text} />}
      {run.controls
        .filter((control) => control.state === "open" || control.state === "answering")
        .map((control) => (
          <ControlRow
            key={control.promptId}
            control={control}
            answer={(body) => post(`controls/${encodeURIComponent(control.promptId)}`, body)}
          />
        ))}
      {run.controls
        .filter((control) => control.state === "expired")
        .map((control) => (
          <span key={control.promptId} className="text-xs text-muted">
            A Hermes request expired: {control.command ?? control.question ?? control.promptId}
          </span>
        ))}
      {run.reconnecting && <Notice tone="warn">{run.reconnecting}</Notice>}
      {run.error && <Notice tone={run.state === "sending" ? "warn" : "fail"}>{run.error}</Notice>}
      {error && <Notice tone="fail">{error}</Notice>}
      {run.state === "cancelled" && run.stopRequested && (
        <span className="text-muted">Stopped. Steps Hermes completed are not undone.</span>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Chip tone={RUN_TONE[run.state]}>{run.state}</Chip>
        <span>
          Provider {run.provider ?? "unknown"}, model {run.model ?? "unknown"}.
        </span>
        {live && run.runId && (
          <Button size="sm" variant="danger" onClick={() => void post("stop")}>
            Stop
          </Button>
        )}
        {run.state === "sending" && (
          <Button size="sm" onClick={() => void post("retry")}>
            Retry
          </Button>
        )}
      </div>
      {run.state === "unknown" && !run.resolution && (
        <Reconcile
          resend={false}
          load={async () =>
            parse(
              HermesRunFacts,
              await api.get(`hermes/chat/runs/${run.id}/reconcile`),
              "Hermes reconcile",
            )
          }
          act={(body) => post("resolve", body)}
        />
      )}
    </div>
  );
}

/** Applies one event of the session topic to the runs shown. */
function reduce(runs: HermesChatRun[], event: HermesChatEvent): HermesChatRun[] {
  if (event.type === "snapshot") return event.runs;
  if (event.type === "delta")
    return runs.map((run) =>
      run.id === event.runId ? { ...run, text: run.text + event.delta } : run,
    );
  const index = runs.findIndex((run) => run.id === event.run.id);
  return index === -1
    ? [...runs, event.run]
    : runs.map((run, at) => (at === index ? event.run : run));
}

function SessionView({ session, ready }: { session: HermesChatSession; ready: boolean }) {
  const api = useApi();
  const [messages, setMessages] = useState<HermesChatMessages["messages"] | undefined>();
  const [more, setMore] = useState(false);
  const [runs, setRuns] = useState<HermesChatRun[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const id = session.id;

  /** The newest page, oldest first. Hermes pages from the newest with `order=latest`. */
  const loadMessages = useCallback(
    (offset = 0) =>
      api
        .get(
          `hermes/chat/sessions/${encodeURIComponent(id)}/messages?limit=${PAGE}&offset=${offset}&order=latest`,
        )
        .then((body) => {
          const page = parse(HermesChatMessages, body, "Hermes messages").messages.reverse();
          setMore(page.length === PAGE);
          setMessages((shown) => (offset === 0 ? page : [...page, ...(shown ?? [])]));
        })
        .catch((caught: unknown) => setError(message(caught))),
    [api, id],
  );
  useEffect(() => {
    if (ready) void loadMessages();
  }, [ready, loadMessages]);
  useEffect(
    () =>
      api.subscribe(`hermes:session:${id}`, (event) => {
        const next = event as HermesChatEvent;
        setRuns((shown) => reduce(shown, next));
        // An ended run is in the stored transcript now.
        if (next.type === "run" && ENDED.has(next.run.state)) void loadMessages();
      }),
    [api, id, loadMessages],
  );

  const active = runs.find(
    (run) => !ENDED.has(run.state) || (run.state === "unknown" && !run.resolution),
  );
  const send = async () => {
    setError(undefined);
    try {
      const body = (await api.send("POST", `hermes/chat/sessions/${encodeURIComponent(id)}/runs`, {
        text,
      })) as { run: HermesChatRun };
      setText("");
      setRuns((shown) => reduce(shown, { type: "run", run: body.run }));
    } catch (caught) {
      setError(message(caught));
    }
  };
  // Every run still going or that did not complete, and the newest one, for its status line.
  const shown = runs.filter((run, index) => run.state !== "completed" || index === runs.length - 1);
  const sendable = !session.readOnly;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3 max-md:px-4">
        <a href="#/hermes" className="text-sm text-accent md:hidden">
          All sessions
        </a>
        <h1 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold">
          {session.title ?? session.id}
        </h1>
        {session.kind === "handoff" && <Chip tone="neutral">handoff</Chip>}
        <span className="text-xs text-muted max-md:basis-full">
          Provider {session.provider ?? "unknown"}, model {session.model ?? "unknown"}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4 max-md:px-4">
        {more && (
          <Button size="sm" onClick={() => void loadMessages(messages?.length ?? 0)}>
            Load older
          </Button>
        )}
        {messages?.map((entry) => (
          <StoredMessage key={entry.id} entry={entry} />
        ))}
        {messages?.length === 0 && runs.length === 0 && (
          <p className="m-0 text-muted">No messages yet.</p>
        )}
        {shown.map((run) => (
          <RunBlock key={run.id} run={run} />
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-6 py-3 max-md:px-4">
        {error && <Notice tone="fail">{error}</Notice>}
        {sendable ? (
          <>
            <Textarea
              aria-label="Message"
              rows={3}
              value={text}
              placeholder={active ? "Wait for the run to end, or stop it." : "Message Hermes"}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim())
                  void send();
              }}
            />
            <div className="flex justify-end">
              <Button
                variant="primary"
                disabled={!ready || !text.trim() || active !== undefined}
                onClick={() => void send()}
              >
                Send
              </Button>
            </div>
          </>
        ) : (
          <p className="m-0 text-sm text-muted">Read-only: {session.readOnly}.</p>
        )}
      </div>
    </div>
  );
}

export function HermesPage({
  store,
  params,
}: {
  store: StatusStore;
  params: Readonly<Record<string, string>>;
}) {
  const api = useApi();
  const status = useSyncExternalStore(store.subscribe, store.get);
  const [sessions, setSessions] = useState<HermesChatSession[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const ready = status?.state === "ready";
  const selected = params.sessionId;
  const load = useCallback(() => {
    api
      .get("hermes/chat/sessions")
      .then((body) => {
        setSessions(parse(HermesChatSessionList, body, "Hermes sessions").sessions);
        setError(undefined);
      })
      .catch((caught: unknown) => setError(message(caught)));
  }, [api]);
  // Read again when Hermes is back, so the page recovers without a reload.
  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  if (!status)
    return (
      <Page>
        <p className="m-0 text-muted">Loading...</p>
      </Page>
    );
  if (status.state === "disabled")
    return (
      <Page>
        <PageHeader title="Hermes" />
        <Notice>
          Hermes is off. Turn it on with <code>hermes.enabled</code> on the{" "}
          <a href="#/settings" className="text-accent">
            Settings
          </a>{" "}
          page.
        </Notice>
      </Page>
    );
  const session = sessions?.find((entry) => entry.id === selected);
  return (
    <div className="flex h-full min-h-0 max-md:flex-col max-md:overflow-y-auto">
      <aside
        className={cn(
          "flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-line p-4",
          selected ? "max-md:hidden" : "max-md:w-full max-md:overflow-visible max-md:border-r-0",
        )}
      >
        <h1 className="m-0 text-lg font-semibold">Hermes</h1>
        <StatusLine status={status} />
        {ready && (
          <NewSession
            profile={status.profile}
            onMade={(made) => {
              load();
              window.location.hash = `#/hermes/${encodeURIComponent(made.id)}`;
            }}
          />
        )}
        {error && <Notice tone="fail">{error}</Notice>}
        <nav aria-label="Hermes sessions" className="flex flex-col gap-0.5">
          {sessions?.map((entry) => (
            <SessionRow key={entry.id} session={entry} selected={entry.id === selected} />
          ))}
          {sessions?.length === 0 && <p className="m-0 text-sm text-muted">No sessions yet.</p>}
        </nav>
      </aside>
      <main className={cn("min-h-0 min-w-0 flex-1", !selected && "max-md:flex-none")}>
        {selected ? (
          session ? (
            <SessionView key={session.id} session={session} ready={ready} />
          ) : (
            <Page>
              {sessions ? (
                <EmptyState title="No such session">
                  Hermes lists no session <code>{selected}</code>.
                </EmptyState>
              ) : (
                <p className="m-0 text-muted">
                  {ready
                    ? "Loading..."
                    : `Hermes is ${status.state}. The session shows when it is back.`}
                </p>
              )}
            </Page>
          )
        ) : (
          <div className="h-full overflow-y-auto px-6 py-4 max-md:h-auto max-md:overflow-visible max-md:px-4">
            <Handoffs />
          </div>
        )}
      </main>
    </div>
  );
}
