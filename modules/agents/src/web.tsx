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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import Type from "typebox";
import { Composer, DialogCard } from "./composer.js";
import { MessageList } from "./messages.js";
import { activity, emptyPage, reducePage } from "./page-state.js";
import { needsRefresh, workspaceStatus } from "./status.js";

const AgentBody = Type.Object({ agent: Type.Object({ id: Type.String() }) });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/** How often the workspace list asks for agent statuses while an agent is busy. */
const STATUS_REFRESH_MS = 5_000;

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

/** The chat with a workspace's worker agent: the middle pane of the workspace view. */
function ChatPane({ workspace }: { workspace: Workspace }) {
  const api = useApi();
  const workspaceId = workspace.id;
  const [agentId, setAgentId] = useState<string | undefined>();
  const [state, dispatch] = useReducer(reducePage, undefined, emptyPage);
  const [models, setModels] = useState<
    { models: AgentModel[]; thinkingLevels: string[] } | undefined
  >();
  const [error, setError] = useState<string | undefined>();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api
      .send("POST", "agents", { workspaceId })
      .then((body) => setAgentId(parse(AgentBody, body, "agent").agent.id))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, workspaceId]);

  useEffect(() => {
    if (!agentId) return;
    return api.subscribe(`agent:${agentId}`, dispatch);
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
    if (models || !agentId) return;
    api
      .get(`agents/${agentId}/models`)
      .then((body) => setModels(parse(ModelList, body, "models")))
      .catch((caught: unknown) => setError(message(caught)));
  };

  const loadCommands = useCallback(async () => {
    if (!agentId) return [];
    return parse(CommandList, await api.get(`agents/${agentId}/commands`), "commands").commands;
  }, [api, agentId]);

  const { agent, chat, dialogs, contextUsage } = state;
  const busy = chat.busy || agent?.status === "busy";
  const active = workspace.state === "active";
  const currentModel = state.model ? modelKey(state.model) : "";
  const modelOptions = models?.models ?? (state.model ? [state.model] : []);

  const controls = (
    <>
      <Select
        value={currentModel}
        onFocus={loadModels}
        onChange={(event) => {
          const [provider, ...rest] = event.target.value.split("/");
          void call("POST", "model", { provider, modelId: rest.join("/") });
        }}
        disabled={!agentId || !active}
        className="w-48 min-w-0 xl:w-72"
        aria-label="Model for the next message"
        title="Model for the next message"
      >
        {!currentModel && <option value="">Model</option>}
        {modelOptions.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)}>
            {model.name ?? model.id} ({model.provider})
          </option>
        ))}
      </Select>
      <Select
        value={state.thinkingLevel ?? ""}
        onFocus={loadModels}
        onChange={(event) => void call("POST", "thinking", { level: event.target.value })}
        disabled={!agentId || !active}
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
          disabled={!agentId || busy || !active}
        >
          Compact
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void call("POST", "stop")}
          disabled={!agent || agent.status === "stopped" || busy}
          title="Stop the agent process; the chat is kept"
        >
          Stop agent
        </Button>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-5 xl:px-6">
          {!active && (
            <Notice tone="warn">
              {workspace.state === "parked"
                ? "This workspace is parked. Its chat is read-only until you resume it."
                : "This workspace is archived. Its chat is read-only."}
            </Notice>
          )}
          {agent?.status === "waiting" && (
            <Notice>Waiting for a free agent slot (at most 4 run at once).</Notice>
          )}
          {agent?.error && (
            <Notice tone="fail">
              <pre className="m-0 whitespace-pre-wrap">{agent.error}</pre>
            </Notice>
          )}
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

          {active && chat.messages.length === 0 && !chat.streaming && (
            <EmptyState icon={MessageSquare} title="No messages yet">
              The agent starts with your first message.
            </EmptyState>
          )}
          <MessageList
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

      <div className="shrink-0 px-4 pb-4 xl:px-6">
        <div className="mx-auto max-w-3xl">
          <WorkingIndicator label={activity(state)} />
          <Composer
            busy={busy}
            disabled={!agentId || !active}
            loadCommands={loadCommands}
            controls={controls}
            onSend={async (text, whileBusy) => {
              await call("POST", "prompt", { message: text, ...(busy ? { whileBusy } : {}) });
            }}
            onAbort={() => void call("POST", "abort")}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Status lines for the workspace list. Asks again on focus and navigation, and every few seconds only while an
 * agent is busy, so an idle list makes no requests.
 */
function useAgentStatus(workspaces: readonly Workspace[]) {
  const api = useApi();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    window.addEventListener("hashchange", again);
    return () => {
      window.removeEventListener("focus", again);
      window.removeEventListener("hashchange", again);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick asks again on purpose
  useEffect(() => {
    let current = true;
    api
      .get("agents")
      .then((body) => current && setAgents(parse(AgentList, body, "agent list").agents))
      .catch((caught: unknown) => console.error(`pi-spore: agent statuses: ${message(caught)}`));
    return () => {
      current = false;
    };
  }, [api, tick]);

  const refresh = needsRefresh(agents);
  useEffect(() => {
    if (!refresh) return;
    const timer = setInterval(() => setTick((n) => n + 1), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return useMemo(() => {
    const workers = new Map(
      agents.filter((agent) => agent.role === "worker").map((agent) => [agent.workspaceId, agent]),
    );
    return new Map(
      workspaces.map((workspace) => [
        workspace.id,
        workspaceStatus(workspace, workers.get(workspace.id)),
      ]),
    );
  }, [agents, workspaces]);
}

export const agentsWeb: WebModule = {
  id: "agents",
  requires: ["workspaces"],
  core: true,
  setup(host) {
    const view = host.use(WorkspaceViewKey);
    view.setMain(ChatPane);
    view.setStatus(useAgentStatus);
  },
};
