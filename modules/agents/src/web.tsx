import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  type Agent,
  AgentList,
  type AgentModel,
  CommandList,
  ModelList,
  parse,
  type Workspace,
} from "@pi-spore/shared";
import { Button, Chip, EmptyState, Notice, Select, Spinner, Tooltip } from "@pi-spore/ui";
import { MessageSquare } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import Type from "typebox";
import { ChatBar } from "./chats.js";
import { Composer, DialogCard } from "./composer.js";
import { Helpers } from "./helpers.js";
import { MessageList } from "./messages.js";
import { activity, emptyPage, reducePage, routedModel } from "./page-state.js";
import { reduceAgentList, workspaceStatuses } from "./status.js";
import { type AgentsWeb, AgentsWebKey, type UserWait, type UseUserWaits } from "./web-contract.js";

export * from "./web-contract.js";

const AgentBody = Type.Object({ agent: Type.Object({ id: Type.String() }) });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

const STATUS_TONE = {
  busy: "run",
  starting: "run",
  waiting: "warn",
  idle: "neutral",
  stopped: "neutral",
  failed: "fail",
} as const;

function ContextMeter({
  percent,
  tokens,
  window,
}: {
  percent: number | null;
  tokens: number | null;
  window: number;
}) {
  const shown = percent === null ? "-" : `${Math.round(percent)}%`;
  const title =
    tokens === null
      ? "Unknown until the next reply"
      : `${tokens.toLocaleString()} of ${window.toLocaleString()} tokens`;
  return (
    <Tooltip label={title} side="bottom">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the tooltip */}
      <span tabIndex={0} className="flex items-center gap-2 font-mono text-xs text-muted">
        <span className="relative hidden h-1.5 w-16 overflow-hidden rounded-full bg-raised xl:block">
          <span
            className="absolute inset-y-0 left-0 bg-accent"
            style={{ width: `${Math.min(100, percent ?? 0)}%` }}
          />
        </span>
        context {shown}
      </span>
    </Tooltip>
  );
}

/** A spinner with what the agent is doing and how long it has been at it. */
function WorkingIndicator({ label }: { label: string | undefined }) {
  const [since, setSince] = useState<number | undefined>();
  const [, tick] = useState(0);
  const working = label !== undefined;
  useEffect(() => {
    if (!working) {
      setSince(undefined);
      return;
    }
    setSince((current) => current ?? Date.now());
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [working]);
  if (!working) return null;
  const seconds = since === undefined ? 0 : Math.floor((Date.now() - since) / 1_000);
  return (
    <div
      className="flex items-center gap-2 px-1 pb-2 text-sm text-accent-strong"
      role="status"
      aria-live="polite"
    >
      <Spinner />
      <span>{label}</span>
      <span className="font-mono text-xs text-muted">{seconds}s</span>
    </div>
  );
}

/**
 * The middle pane of the workspace view: the workspace's chats (ADR 0030) and the selected one. Without a chat in
 * the route it shows the active worker chat, which the first visit creates.
 */
function ChatPane({ workspace, chatId }: { workspace: Workspace; chatId?: string }) {
  const api = useApi();
  const workspaceId = workspace.id;
  const [chats, setChats] = useState<Agent[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  const archived = workspace.state === "archived";

  const load = useCallback(async () => {
    try {
      // An archived workspace starts no chat (409 workspace_archived); it shows the chats it still has.
      if (!archived) await api.send("POST", "agents", { workspaceId });
      const body = await api.get(`agents?workspaceId=${encodeURIComponent(workspaceId)}`);
      setChats(parse(AgentList, body, "chat list").agents);
    } catch (caught) {
      setError(message(caught));
    }
  }, [api, workspaceId, archived]);

  useEffect(() => {
    setChats(undefined);
    void load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const selected =
    chats?.find((chat) => chat.id === chatId) ??
    chats?.find((chat) => chat.kind === "worker" && chat.active);

  const startChat = (kind: "worker" | "side", fork: boolean) => {
    api
      .send("POST", "agents/chats", { workspaceId, kind, ...(fork ? { fork } : {}) })
      .then((body) => {
        const { agent } = parse(AgentBody, body, "chat");
        window.location.hash = `#/workspaces/${workspaceId}/chats/${agent.id}`;
        return load();
      })
      .catch((caught: unknown) => setError(message(caught)));
  };

  const closeChat = (chat: Agent) => {
    const name = chat.title ?? "New chat";
    if (!window.confirm(`Close "${name}"? It leaves the chat bar for good.`)) return;
    api
      .send("POST", `agents/${chat.id}/close`)
      .then(() => {
        // The page's next load starts a fresh worker chat if the active one was closed.
        if (chat.id === selected?.id) window.location.hash = `#/workspaces/${workspaceId}`;
        return load();
      })
      .catch((caught: unknown) => setError(message(caught)));
  };

  if (!selected) {
    if (archived && chats && !error) {
      return (
        <div className="p-4">
          <Notice tone="warn">This workspace is archived and has no chats.</Notice>
        </div>
      );
    }
    return error ? (
      <div className="p-4">
        <Notice tone="fail">{error}</Notice>
      </div>
    ) : null;
  }
  return (
    <ChatView
      key={selected.id}
      workspace={workspace}
      agentId={selected.id}
      bar={
        <ChatBar
          workspaceId={workspaceId}
          chats={chats ?? []}
          selected={selected}
          canStart={workspace.state === "active"}
          onNew={startChat}
          onClose={closeChat}
          onRename={async (title) => {
            try {
              await api.send("POST", `agents/${selected.id}/title`, { title });
              await load();
            } catch (caught) {
              setError(message(caught));
              throw caught;
            }
          }}
        />
      }
      outerError={error}
      onDismissOuterError={() => setError(undefined)}
      onChatChanged={() => void load()}
    />
  );
}

/** Panels other modules added to the chat page, shown above the composer. */
const chatPanels = new Map<string, ComponentType<{ chatId: string }>>();

/** One chat: its messages, dialogs, and composer. An older worker chat has a read-only strip in place of the composer. */
function ChatView({
  workspace,
  agentId,
  bar,
  outerError,
  onDismissOuterError,
  onChatChanged,
}: {
  workspace: Workspace;
  agentId: string;
  bar: ReactNode;
  /** An error from the chat list, such as a refused "New chat". */
  outerError: string | undefined;
  onDismissOuterError: () => void;
  /** The chat's title or active flag changed, so the list is out of date. */
  onChatChanged: () => void;
}) {
  const api = useApi();
  const [state, dispatch] = useReducer(reducePage, undefined, emptyPage);
  const [models, setModels] = useState<
    { models: AgentModel[]; thinkingLevels: string[] } | undefined
  >();
  const [error, setError] = useState<string | undefined>();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const changed = useRef(onChatChanged);
  changed.current = onChatChanged;

  useEffect(() => {
    return api.subscribe(`agent:${agentId}`, (event) => {
      dispatch(event);
      if ((event as { type?: string }).type === "agent") changed.current();
      // A reply that ends while the user watches this chat does not wait for them on Home.
      const pi = (event as { type?: string; event?: { type?: string; aborted?: boolean } }).event;
      if (
        pi?.type === "agent_settled" &&
        pi.aborted !== true &&
        document.visibilityState === "visible"
      ) {
        api
          .send("POST", `agents/${agentId}/seen`)
          .catch((caught: unknown) => console.error(`pi-spore: mark seen: ${message(caught)}`));
      }
    });
  }, [api, agentId]);

  // Follow new output only while the reader is already at the bottom.
  const onScroll = () => {
    const box = scroller.current;
    if (box) stick.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
  };
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  });

  const call = useCallback(
    (method: "POST", path: string, body?: unknown) =>
      api.send(method, `agents/${agentId}/${path}`, body).catch((caught: unknown) => {
        setError(message(caught));
        throw caught;
      }),
    [api, agentId],
  );

  const loadModels = () => {
    if (models) return;
    api
      .get(`agents/${agentId}/models`)
      .then((body) => setModels(parse(ModelList, body, "models")))
      .catch((caught: unknown) => setError(message(caught)));
  };

  const loadCommands = useCallback(async () => {
    return parse(CommandList, await api.get(`agents/${agentId}/commands`), "commands").commands;
  }, [api, agentId]);

  const { agent, chat, children, dialogs, contextUsage } = state;
  const busy = chat.busy || agent?.status === "busy";
  // Runs only in an active workspace, and only as the active worker chat or a side chat (ADR 0030).
  const older = agent?.kind === "worker" && !agent.active;
  const active = workspace.state === "active" && agent?.active === true;
  const currentModel = state.model ? modelKey(state.model) : "";
  const modelOptions = models?.models ?? (state.model ? [state.model] : []);
  // A virtual model such as spore/auto answers through another model; the picker names it (ADR 0009).
  const routed = routedModel(state);
  const routedTo = routed && modelKey(routed) !== currentModel ? routed : undefined;

  const controls = (
    <>
      <Select
        value={currentModel}
        onFocus={loadModels}
        onChange={(event) => {
          const [provider, ...rest] = event.target.value.split("/");
          void call("POST", "model", { provider, modelId: rest.join("/") });
        }}
        disabled={!active}
        className="w-48 min-w-0 xl:w-96"
        aria-label="Model for the next message"
        title="Model for the next message"
      >
        {!currentModel && <option value="">Model</option>}
        {modelOptions.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)}>
            {`${model.name ?? model.id} (${model.provider})${
              routedTo && modelKey(model) === currentModel ? ` → ${routedTo.id}` : ""
            }`}
          </option>
        ))}
      </Select>
      <Select
        value={state.thinkingLevel ?? ""}
        onFocus={loadModels}
        onChange={(event) => void call("POST", "thinking", { level: event.target.value })}
        disabled={!active}
        className="w-24"
        aria-label="Thinking level"
        title="Thinking level"
      >
        {!state.thinkingLevel && <option value="">Thinking</option>}
        {(models?.thinkingLevels ?? (state.thinkingLevel ? [state.thinkingLevel] : [])).map(
          (level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ),
        )}
      </Select>
    </>
  );

  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <h1 className="m-0 min-w-0 truncate text-sm font-semibold">{workspace.name}</h1>
        {workspace.line && (
          <Chip mono title={workspace.line} className="hidden max-w-48 xl:inline-block">
            {workspace.line}
          </Chip>
        )}
        {agent && <Chip tone={STATUS_TONE[agent.status]}>{agent.status}</Chip>}
        <div className="flex-1" />
        {contextUsage && (
          <ContextMeter
            percent={contextUsage.percent}
            tokens={contextUsage.tokens}
            window={contextUsage.contextWindow}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void call("POST", "compact")}
          disabled={busy || !active}
        >
          Compact
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void call("POST", "stop")}
          disabled={
            !agent ||
            agent.status === "stopped" ||
            busy ||
            children.some((run) => run.state === "running")
          }
          title="Stop the agent process; the chat is kept. Not while a helper runs."
        >
          Stop agent
        </Button>
      </header>
      {bar}

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-5 xl:px-6">
          {agent?.kind === "side" && (
            <Notice>
              Side chat. It can read and search files but cannot change them, run commands, or start
              agents.
            </Notice>
          )}
          {workspace.state !== "active" && (
            <Notice tone="warn">
              {workspace.state === "parked"
                ? "This workspace is parked. Its chat is read-only until you resume it."
                : "This workspace is archived. Its chat is read-only."}
            </Notice>
          )}
          {agent?.status === "waiting" && (
            <Notice>
              Waiting for a free agent slot (at most 4 run at once, helper runs included).
            </Notice>
          )}
          {agent?.error && (
            <Notice tone="fail">
              <pre className="m-0 whitespace-pre-wrap">{agent.error}</pre>
            </Notice>
          )}
          {[
            { text: error, dismiss: () => setError(undefined) },
            { text: outerError, dismiss: onDismissOuterError },
          ].map(
            ({ text, dismiss }) =>
              text && (
                <Notice key={text} tone="fail">
                  <div className="flex items-start gap-2">
                    <span className="flex-1">{text}</span>
                    <Button size="sm" variant="ghost" onClick={dismiss}>
                      Dismiss
                    </Button>
                  </div>
                </Notice>
              ),
          )}

          {active && chat.messages.length === 0 && !chat.streaming && (
            <EmptyState icon={MessageSquare} title="No messages yet">
              The agent starts with your first message.
            </EmptyState>
          )}
          <MessageList
            agentId={agentId}
            messages={chat.messages}
            running={chat.running}
            {...(chat.streaming ? { streaming: chat.streaming } : {})}
          />
          {(chat.queue.steering.length > 0 || chat.queue.followUp.length > 0) && (
            <div className="flex flex-col gap-1 text-sm text-muted">
              {chat.queue.steering.map((queued) => (
                <p key={`s-${queued}`} className="m-0">
                  Queued (steer): {queued}
                </p>
              ))}
              {chat.queue.followUp.map((queued) => (
                <p key={`f-${queued}`} className="m-0">
                  Queued (follow-up): {queued}
                </p>
              ))}
            </div>
          )}
          <Helpers agentId={agentId} runs={children} />
          {state.notices.map((notice) => (
            <Notice key={notice.id} tone={notice.level === "error" ? "fail" : "info"}>
              {notice.message}
            </Notice>
          ))}
          {dialogs.map((dialog) => (
            <DialogCard
              key={dialog.id}
              dialog={dialog}
              onAnswer={(answer) => void call("POST", "dialog", { dialogId: dialog.id, ...answer })}
            />
          ))}
        </div>
      </div>

      {older && (
        <div className="shrink-0 px-4 pb-4 xl:px-6">
          <div className="mx-auto max-w-3xl">
            <Notice tone="warn">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={workspace.state !== "active"}
                  onClick={() => void call("POST", "activate").then(onChatChanged)}
                >
                  Make active
                </Button>
                <span className="flex-1">
                  This is an older orchestrator chat. It is read-only. Make it active to continue
                  it; the current orchestrator chat stops first.
                </span>
              </div>
            </Notice>
          </div>
        </div>
      )}
      {!older && (
        <div className="shrink-0 px-4 pb-4 xl:px-6">
          <div className="mx-auto max-w-3xl">
            {active &&
              [...chatPanels].map(([id, ChatPanel]) => <ChatPanel key={id} chatId={agentId} />)}
            <WorkingIndicator label={activity(state)} />
            <Composer
              chatId={agentId}
              busy={busy}
              disabled={!active}
              loadCommands={loadCommands}
              controls={controls}
              imageInput={state.model?.input?.includes("image")}
              onSend={async (text, whileBusy, images) => {
                await call("POST", "prompt", {
                  message: text,
                  ...(images.length > 0 ? { images } : {}),
                  ...(busy ? { whileBusy } : {}),
                });
              }}
              onAbort={() => void call("POST", "abort")}
            />
          </div>
        </div>
      )}
    </section>
  );
}

const NO_WAITS: ReadonlyMap<string, UserWait> = new Map();

/** Tells which chats wait for the user. The attention module replaces it. */
let useUserWaits: UseUserWaits = () => NO_WAITS;

/** Status lines follow the shared agent stream, including its snapshot on reconnect. */
function useAgentStatus(workspaces: readonly Workspace[]) {
  const api = useApi();
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(
    () =>
      api.subscribe("agents:list", (event) => {
        setAgents((current) => reduceAgentList(current, event));
      }),
    [api],
  );

  const waits = useUserWaits();
  return useMemo(() => workspaceStatuses(workspaces, agents, waits), [agents, workspaces, waits]);
}

export const agentsWeb: WebModule = {
  id: "agents",
  requires: ["workspaces"],
  core: true,
  setup(host) {
    const web: AgentsWeb = {
      addChatPanel: (id, panel) => {
        chatPanels.set(id, panel);
      },
      setUserWaits: (hook) => {
        useUserWaits = hook;
      },
      DialogCard,
    };
    host.provide(AgentsWebKey, web);
    const view = host.use(WorkspaceViewKey);
    view.setMain(ChatPane);
    view.setStatus(useAgentStatus);
  },
};
