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
  useConfirm,
  useFollowBottom,
} from "@pi-spore/ui";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ControlRow, Handoffs, Reconcile } from "./handoffs-page.js";

/** How often the status is read again. The server answers from its cache, so this sends Hermes nothing. */
export const STATUS_MS = 5_000;
/** Messages per page of the stored transcript. */
const PAGE = 100;
/** Pages read at most to reach the messages shown already, after a reconnect or a run's end. */
const CATCH_UP_PAGES = 10;
/** Hermes keeps a run's Idempotency-Key for 24 h after the run ends (spike Q2). */
const KEY_RETENTION_MS = 24 * 3_600_000;

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

const UNTRUSTED_OPEN = /^<untrusted_tool_result\b[^>]*>\s*/;
const UNTRUSTED_CLOSE = "</untrusted_tool_result>";

/**
 * The short line of a tool result. Hermes wraps mcp_ and browser_ results in `<untrusted_tool_result>` with a
 * notice first; the line skips both, as Hermes's desktop app does, so it shows what the tool said.
 */
function toolPreview(content: string): string {
  let text = content.trim();
  const open = UNTRUSTED_OPEN.exec(text);
  const close = text.lastIndexOf(UNTRUSTED_CLOSE);
  if (open && close >= open[0].length) {
    const inner = text.slice(open[0].length, close);
    const notice = inner.indexOf("\n\n");
    text = (notice < 0 ? inner : inner.slice(notice + 2)).trim();
  }
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** A stored message. Roles other than user, assistant, and tool (such as `session_meta`) are not shown. */
function StoredMessage({ entry }: { entry: HermesChatMessages["messages"][number] }) {
  const label = roleLabel[entry.role];
  if (!label) return null;
  if (entry.role === "tool") {
    if (!entry.content) return <div className="text-xs text-muted">Tool {entry.tool ?? ""}</div>;
    return (
      <details className="group text-xs text-muted">
        <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          />
          <span className="min-w-0 truncate">
            Tool {entry.tool ?? ""}: {toolPreview(entry.content)}
          </span>
        </summary>
        <pre className="m-0 mt-1 max-h-80 overflow-auto rounded-lg border border-line bg-panel p-2.5 font-mono text-xs text-fg [overflow-wrap:anywhere] whitespace-pre-wrap">
          {entry.content}
        </pre>
      </details>
    );
  }
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
function RunBlock({ run, inputStored }: { run: HermesChatRun; inputStored: boolean }) {
  const api = useApi();
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<string | undefined>();
  const post = async (path: string, body: unknown = {}) => {
    setError(undefined);
    try {
      await api.send("POST", `hermes/chat/runs/${run.id}/${path}`, body);
    } catch (caught) {
      setError(message(caught));
    }
  };
  const retry = async () => {
    // Past 24 h, Hermes may have dropped the key of a first try that ended, and the retry would run it again.
    if (Date.now() - run.createdAt < KEY_RETENTION_MS) return await post("retry");
    const yes = await confirm({
      title: "Retry after 24 h?",
      message:
        "The first try was sent 24 h or more ago. If Hermes ran it and it ended more than 24 h ago, Hermes dropped its key, and this runs the message again. Its side effects would happen twice.",
      confirmLabel: "Retry",
      tone: "danger",
    });
    if (yes) await post("retry", { confirmed: true });
  };
  const live = !ENDED.has(run.state);
  return (
    <div className="flex flex-col gap-2 border-l-2 border-line pl-3 text-sm">
      {dialog}
      {/* Not in the stored transcript yet: a live run's input, or one Hermes never got. */}
      {(live ? !inputStored : !run.runId) && (
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
          <Button size="sm" onClick={() => void retry()}>
            Retry
          </Button>
        )}
      </div>
      {run.state === "unknown" && !run.resolution && (
        <span className="text-muted">
          Hermes holds this session until the lost run is marked as interrupted.
        </span>
      )}
      {run.state === "unknown" && !run.resolution && (
        <Reconcile
          more={false}
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

/**
 * Applies one event of the session topic to the runs shown. A delta whose `seq` the run's text already holds is
 * skipped: a snapshot built while deltas came in has them, and the hub sends them again after it.
 */
function reduce(runs: HermesChatRun[], event: HermesChatEvent): HermesChatRun[] {
  if (event.type === "snapshot") return event.runs;
  if (event.type === "delta")
    return runs.map((run) =>
      run.id === event.runId && event.seq > run.textSeq
        ? { ...run, text: run.text + event.delta, textSeq: event.seq }
        : run,
    );
  const index = runs.findIndex((run) => run.id === event.run.id);
  return index === -1
    ? [...runs, event.run]
    : runs.map((run, at) => (at === index ? event.run : run));
}

function SessionView({ session, ready }: { session: HermesChatSession; ready: boolean }) {
  const api = useApi();
  const [messages, setMessages] = useState<HermesChatMessages["messages"] | undefined>();
  const messagesRef = useRef<HermesChatMessages["messages"] | undefined>(undefined);
  const follow = useFollowBottom();
  const [more, setMore] = useState(false);
  const [runs, setRuns] = useState<HermesChatRun[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const id = session.id;

  const fetchPage = useCallback(
    async (offset: number) =>
      parse(
        HermesChatMessages,
        await api.get(
          `hermes/chat/sessions/${encodeURIComponent(id)}/messages?limit=${PAGE}&offset=${offset}&order=latest`,
        ),
        "Hermes messages",
      ).messages,
    [api, id],
  );
  const show = useCallback((list: HermesChatMessages["messages"]) => {
    const sorted = [...new Map(list.map((entry) => [entry.id, entry])).values()].sort(
      (a, b) => a.id - b.id,
    );
    messagesRef.current = sorted;
    setMessages(sorted);
  }, []);
  /**
   * Reads pages from the newest (`order=latest`) until one reaches a message shown already, so the list stays one
   * unbroken run back from the newest message, and "Load older" can page on from its length. With no overlap within
   * `CATCH_UP_PAGES`, the list starts over from what was read. The first read takes one page.
   */
  const catchUp = useCallback(async () => {
    try {
      const known = messagesRef.current;
      const newest = known?.at(-1)?.id;
      const read: HermesChatMessages["messages"] = [];
      let overlap = false;
      let start = false;
      for (let page = 0; page < (known ? CATCH_UP_PAGES : 1); page += 1) {
        const entries = await fetchPage(page * PAGE);
        read.push(...entries);
        if (entries.length < PAGE) {
          start = true;
          break;
        }
        if (newest !== undefined && entries.some((entry) => entry.id <= newest)) {
          overlap = true;
          break;
        }
      }
      const current = messagesRef.current;
      if (current && (overlap || start)) show([...current, ...read]);
      else show(read);
      if (start) setMore(false);
      else if (!overlap) setMore(true);
    } catch (caught) {
      setError(message(caught));
    }
  }, [fetchPage, show]);
  const loadOlder = async () => {
    try {
      const entries = await fetchPage(messagesRef.current?.length ?? 0);
      setMore(entries.length === PAGE);
      show([...(messagesRef.current ?? []), ...entries]);
    } catch (caught) {
      setError(message(caught));
    }
  };
  useEffect(() => {
    if (ready) void catchUp();
  }, [ready, catchUp]);
  useEffect(
    () =>
      api.subscribe(`hermes:session:${id}`, (event) => {
        const next = event as HermesChatEvent;
        setRuns((shown) => reduce(shown, next));
        // An ended run is in the stored transcript now. A snapshot (a reconnect) may hold runs that ended meanwhile.
        if (next.type === "snapshot" || (next.type === "run" && ENDED.has(next.run.state)))
          void catchUp();
      }),
    [api, id, catchUp],
  );

  // A run left unknown holds the session in Hermes until it is marked as interrupted.
  const active = runs.find((run) => !ENDED.has(run.state) || run.state === "unknown");
  const send = async () => {
    setError(undefined);
    try {
      const body = (await api.send("POST", `hermes/chat/sessions/${encodeURIComponent(id)}/runs`, {
        text,
      })) as { run: HermesChatRun };
      follow.toBottom();
      setText("");
      setRuns((shown) => reduce(shown, { type: "run", run: body.run }));
    } catch (caught) {
      setError(message(caught));
    }
  };
  // Every run still going or that did not complete, and the newest one, for its status line.
  const shown = runs.filter((run, index) => run.state !== "completed" || index === runs.length - 1);
  // A transcript read after a reconnect may hold the live run's input already: the newest stored user message.
  const lastStoredInput = messages?.findLast((entry) => entry.role === "user")?.content;
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
      <div
        ref={follow.ref}
        onScroll={follow.onScroll}
        role="log"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4 max-md:px-4"
      >
        {more && (
          <Button size="sm" onClick={() => void loadOlder()}>
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
          <RunBlock key={run.id} run={run} inputStored={run.input === lastStoredInput} />
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
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                  return;
                // Enter never adds a line; it sends only when the Send button would.
                event.preventDefault();
                if (ready && text.trim() && active === undefined) void send();
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
