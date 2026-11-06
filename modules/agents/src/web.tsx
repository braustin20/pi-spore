import { useApi, type WebModule } from "@pi-spore/module-api";
import { type AgentModel, CommandList, ModelList, parse, Workspace } from "@pi-spore/shared";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import Type from "typebox";
import { Composer, DialogCard } from "./composer.js";
import { MessageList } from "./messages.js";
import { activity, emptyPage, reducePage } from "./page-state.js";

const WorkspaceBody = Type.Object({ workspace: Workspace });
const AgentBody = Type.Object({ agent: Type.Object({ id: Type.String() }) });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

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
    <span className="meter" title={title}>
      <span className="meter-bar" style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      <span className="meter-text">context {shown}</span>
    </span>
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
    <div className="working" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
      <span className="muted">{seconds}s</span>
    </div>
  );
}

function ChatPage({ params }: { params: Readonly<Record<string, string>> }) {
  const api = useApi();
  const workspaceId = params.workspaceId ?? "";
  const [workspace, setWorkspace] = useState<Workspace | undefined>();
  const [agentId, setAgentId] = useState<string | undefined>();
  const [state, dispatch] = useReducer(reducePage, undefined, emptyPage);
  const [models, setModels] = useState<
    { models: AgentModel[]; thinkingLevels: string[] } | undefined
  >();
  const [error, setError] = useState<string | undefined>();
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api
      .get(`workspaces/${workspaceId}`)
      .then((body) => setWorkspace(parse(WorkspaceBody, body, "workspace").workspace))
      .catch((caught: unknown) => setError(message(caught)));
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
  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
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
  const active = workspace?.state === "active";
  const currentModel = state.model ? modelKey(state.model) : "";
  const modelOptions = models?.models ?? (state.model ? [state.model] : []);

  return (
    <section className="chat">
      <header className="chat-header">
        <div>
          <a href={`#/workspaces/in/${workspace?.projectId ?? ""}`}>Workspaces</a>
          <h1>{workspace?.name ?? "Chat"}</h1>
          {workspace && <code className="muted">{workspace.line ?? workspace.path}</code>}
        </div>
        <div className="chat-controls">
          {agent && <span className={`badge status-${agent.status}`}>{agent.status}</span>}
          <select
            value={currentModel}
            onFocus={loadModels}
            onChange={(event) => {
              const [provider, ...rest] = event.target.value.split("/");
              void call("POST", "model", { provider, modelId: rest.join("/") });
            }}
            disabled={!agentId || !active}
            className="model-select"
            title="Model for the next message"
          >
            {!currentModel && <option value="">Model</option>}
            {modelOptions.map((model) => (
              <option key={modelKey(model)} value={modelKey(model)}>
                {model.name ?? model.id} ({model.provider})
              </option>
            ))}
          </select>
          <select
            value={state.thinkingLevel ?? ""}
            onFocus={loadModels}
            onChange={(event) => void call("POST", "thinking", { level: event.target.value })}
            disabled={!agentId || !active}
            className="thinking-select"
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
          </select>
          {contextUsage && (
            <ContextMeter
              percent={contextUsage.percent}
              tokens={contextUsage.tokens}
              window={contextUsage.contextWindow}
            />
          )}
          <button
            type="button"
            onClick={() => void call("POST", "compact")}
            disabled={!agentId || busy || !active}
          >
            Compact
          </button>
          <button
            type="button"
            onClick={() => void call("POST", "stop")}
            disabled={!agent || agent.status === "stopped" || busy}
            title="Stop the agent process; the chat is kept"
          >
            Stop agent
          </button>
        </div>
      </header>

      {workspace && !active && (
        <p className="warning">
          This workspace is {workspace.state}. Its chat is read-only until you resume it.
        </p>
      )}
      {agent?.status === "waiting" && (
        <p className="muted">Waiting for a free agent slot (at most 4 run at once).</p>
      )}
      {agent?.error && <pre className="error">{agent.error}</pre>}
      {error && (
        <p className="error">
          {error}{" "}
          <button type="button" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </p>
      )}

      {chat.messages.length === 0 && !chat.streaming && (
        <p className="muted">No messages yet. The agent starts with your first message.</p>
      )}
      <MessageList
        messages={chat.messages}
        running={chat.running}
        {...(chat.streaming ? { streaming: chat.streaming } : {})}
      />
      {(chat.queue.steering.length > 0 || chat.queue.followUp.length > 0) && (
        <div className="queue muted">
          {chat.queue.steering.map((queued) => (
            <p key={`s-${queued}`}>Queued (steer): {queued}</p>
          ))}
          {chat.queue.followUp.map((queued) => (
            <p key={`f-${queued}`}>Queued (follow-up): {queued}</p>
          ))}
        </div>
      )}
      {state.notices.map((notice) => (
        <p key={notice.id} className={notice.level === "error" ? "error" : "muted"}>
          {notice.message}
        </p>
      ))}
      {dialogs.map((dialog) => (
        <DialogCard
          key={dialog.id}
          dialog={dialog}
          onAnswer={(answer) => void call("POST", "dialog", { dialogId: dialog.id, ...answer })}
        />
      ))}

      <WorkingIndicator label={activity(state)} />
      <Composer
        busy={busy}
        disabled={!agentId || !active}
        loadCommands={loadCommands}
        onSend={async (text, whileBusy) => {
          await call("POST", "prompt", { message: text, ...(busy ? { whileBusy } : {}) });
        }}
        onAbort={() => void call("POST", "abort")}
      />
      <div ref={bottom} />
    </section>
  );
}

export const agentsWeb: WebModule = {
  id: "agents",
  requires: ["workspaces"],
  core: true,
  setup(host) {
    host.addPage({ path: "/chat/:workspaceId", title: "Chat", component: ChatPage });
  },
};
