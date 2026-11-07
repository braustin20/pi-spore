import {
  type Agent,
  type AgentDialog,
  type AgentModel,
  applyPiEvent,
  type ChatState,
  type ContextUsage,
  emptyChat,
} from "@pi-spore/shared";

export interface Notice {
  /** Stable across the list trimming older notices, for React keys. */
  id: number;
  level: string;
  message: string;
}

/** What the chat page shows for one agent, rebuilt from the `agent:<id>` events (see AgentEvent in manager.ts). */
export interface PageState {
  agent?: Agent;
  model?: AgentModel;
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  dialogs: AgentDialog[];
  chat: ChatState;
  /** The latest extension notices, newest last. */
  notices: Notice[];
}

export const emptyPage = (): PageState => ({ dialogs: [], chat: emptyChat(), notices: [] });

const MAX_NOTICES = 5;

type Event = { type?: unknown } & Record<string, unknown>;

/** Applies one server event. A snapshot replaces everything, so a reconnect catches up in one step. */
export function reducePage(state: PageState, raw: unknown): PageState {
  if (typeof raw !== "object" || raw === null) return state;
  const event = raw as Event;
  switch (event.type) {
    case "snapshot": {
      const next: PageState = {
        agent: event.agent as Agent,
        dialogs: (event.dialogs as AgentDialog[] | undefined) ?? [],
        chat: (event.chat as ChatState | undefined) ?? emptyChat(),
        notices: state.notices,
      };
      if (event.model) next.model = event.model as AgentModel;
      if (typeof event.thinkingLevel === "string") next.thinkingLevel = event.thinkingLevel;
      if (event.contextUsage) next.contextUsage = event.contextUsage as ContextUsage;
      return next;
    }
    case "pi":
      return { ...state, chat: applyPiEvent(state.chat, event.event) };
    case "agent":
      return { ...state, agent: event.agent as Agent };
    case "status": {
      if (!state.agent) return state;
      const { error: _old, ...agent } = state.agent;
      return {
        ...state,
        agent: {
          ...agent,
          status: event.status as Agent["status"],
          ...(typeof event.error === "string" ? { error: event.error } : {}),
        },
      };
    }
    case "model": {
      const { model: _model, thinkingLevel: _thinking, ...rest } = state;
      return {
        ...rest,
        ...(event.model ? { model: event.model as AgentModel } : {}),
        ...(typeof event.thinkingLevel === "string" ? { thinkingLevel: event.thinkingLevel } : {}),
      };
    }
    case "stats": {
      const { contextUsage: _usage, ...rest } = state;
      return {
        ...rest,
        ...(event.contextUsage ? { contextUsage: event.contextUsage as ContextUsage } : {}),
      };
    }
    case "dialog": {
      const dialog = event.dialog as AgentDialog;
      return {
        ...state,
        dialogs: [...state.dialogs.filter((open) => open.id !== dialog.id), dialog],
      };
    }
    case "dialog_closed":
      return { ...state, dialogs: state.dialogs.filter((open) => open.id !== event.dialogId) };
    case "notice":
      return {
        ...state,
        notices: [
          ...state.notices,
          {
            id: (state.notices.at(-1)?.id ?? 0) + 1,
            level: String(event.level),
            message: String(event.message),
          },
        ].slice(-MAX_NOTICES),
      };
    default:
      return state;
  }
}

/**
 * What the agent is doing right now, for the working indicator, or undefined when it is not working. Derived from
 * the state, so it follows reconnects and snapshots without extra events.
 */
export function activity(state: PageState): string | undefined {
  const status = state.agent?.status;
  if (status === "waiting") return "Waiting for a free agent slot";
  if (status === "starting") return "Starting the agent";
  if (status !== "busy" && !state.chat.busy) return undefined;
  if (state.chat.running.length > 0) {
    return `Running ${state.chat.running.map((tool) => tool.toolName).join(", ")}`;
  }
  const content = state.chat.streaming?.content;
  const last = Array.isArray(content)
    ? (content.at(-1) as { type?: unknown; name?: unknown } | undefined)
    : undefined;
  if (last?.type === "text") return "Writing";
  if (last?.type === "toolCall") return `Preparing ${String(last.name ?? "a tool")}`;
  // No output yet, or thinking: models think before their first visible token.
  return "Thinking";
}

/**
 * The physical model the router picked for a virtual model such as `spore/auto`, or undefined before any answer.
 * Pi records the physical model on each assistant message, so this follows reloads and reconnects (ADR 0009).
 */
export function routedModel(state: PageState): { provider: string; id: string } | undefined {
  const messages = state.chat.streaming
    ? [...state.chat.messages, state.chat.streaming]
    : state.chat.messages;
  for (const message of messages.toReversed()) {
    if (
      message.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      return { provider: message.provider, id: message.model };
    }
  }
  return undefined;
}
