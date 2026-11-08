import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type AgentTokens, ApiError, type EventHub, type Logger } from "@pi-spore/module-api";
import {
  type Agent,
  type AgentDialog,
  type AgentModel,
  type AgentStatus,
  applyPiEvent,
  type ChatKind,
  type ChatState,
  type ChildRun,
  type ChildTranscript,
  type ContextUsage,
  chatTitle,
  type DialogAnswer,
  emptyChat,
  type Workspace,
} from "@pi-spore/shared";
import {
  type InspectResult,
  parseChildRuns,
  parseInspectReply,
  runningCount,
} from "./child-runs.js";
import type { AgentAttention, AgentChange } from "./contract.js";
import { ChatImages } from "./images.js";
import { modelArgs, type RoleDefaults, SIDE_CHAT_TOOLS, withModel } from "./launch.js";
import { type PiCommand, PiProcess } from "./rpc.js";
import { readTranscript } from "./transcript.js";

export interface AgentRecord {
  id: string;
  workspaceId: string;
  role: "orchestrator";
  kind: ChatKind;
  /** The workspace's active worker chat, or a side chat: the chat can run (ADR 0030). */
  active: boolean;
  title: string | null;
  /** The worker chat a side chat forks on its first start. */
  forkedFrom: string | null;
  sessionFile: string | null;
  createdAt: number;
  /** When the last run ended and the agent began to wait for the user, or null. */
  waitingSince: number | null;
  /** The user closed the chat: it is off the chat bar and Home, and never runs again. Its session file stays. */
  closed: boolean;
  /** The model a new session starts on, `provider/id`, or null for the role's default (ADR 0120). */
  model: string | null;
}

export interface ManagerOptions {
  pi: PiCommand;
  events: EventHub;
  log: Logger;
  /** Where new sessions of a workspace go: `<sessionsDir>/<workspace id>/`. */
  sessionsDir: string;
  /** Launch arguments that load the user's Pi setup (ADR 0025), for a working folder. */
  resourceArgs(cwd: string): Promise<string[]>;
  /** The model and thinking level a new session of a role starts with (ADR 0013). */
  roleDefaults(role: string): Promise<RoleDefaults>;
  /** Environment for an agent's process. The manager adds `PI_SPORE_URL` and `PI_SPORE_TOKEN`. */
  env(agent: AgentRecord, workspace: Workspace): Promise<Record<string, string>>;
  /** The server's base URL, which spore-bridge calls. */
  url: string;
  /** Issues each process its own bridge token, revoked when the process exits. */
  tokens: AgentTokens;
  now: () => number;
  workspace(id: string): Workspace;
  saveSessionFile(agentId: string, file: string): void;
  saveWaiting(agentId: string, since: number | null): void;
  saveTitle(agentId: string, title: string): void;
  /** Called after a status, dialog, or waiting change, for Home and deliveries. */
  onChange(agentId: string, change: AgentChange): void;
  maxLive: number;
  idleStopMs: number;
  startTimeoutMs: number;
  /** Decoded image bytes kept in memory for pages (ADR 0060); older images are read from session files again. */
  imageCacheBytes: number;
}

/** What the browser gets on subscribe, and the event types after it (topic `agent:<id>`). */
export type AgentEvent =
  | {
      type: "snapshot";
      agent: Agent;
      model?: AgentModel;
      thinkingLevel?: string;
      contextUsage?: ContextUsage;
      dialogs: AgentDialog[];
      chat: ChatState;
      children: ChildRun[];
    }
  | { type: "pi"; event: unknown }
  /** The agent's pi-subagents helpers changed (ADR 0034). */
  | { type: "children"; children: ChildRun[] }
  | { type: "status"; status: AgentStatus; error?: string }
  /** The chat's title or active flag changed. */
  | { type: "agent"; agent: Agent }
  | { type: "model"; model?: AgentModel; thinkingLevel?: string }
  | { type: "stats"; contextUsage?: ContextUsage }
  | { type: "dialog"; dialog: AgentDialog }
  | { type: "dialog_closed"; dialogId: string }
  | { type: "notice"; level: string; message: string };

interface Live {
  record: AgentRecord;
  status: AgentStatus;
  /** When the agent entered its status. */
  since: number;
  error?: string;
  process?: PiProcess;
  /** The bridge token of the running process. */
  token?: string;
  starting?: Promise<PiProcess>;
  stopping: boolean;
  chat: ChatState;
  /** False until the transcript has been read once, so a stopped agent's snapshot still shows its history. */
  loaded: boolean;
  model?: AgentModel;
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  dialogs: Map<string, { dialog: AgentDialog; openedAt: number; timer?: NodeJS.Timeout }>;
  idleTimer?: NodeJS.Timeout;
  /** Background pi-subagents helpers of the running process, from its `subagent-async` widget (ADR 0034). */
  children: ChildRun[];
  /** The last payload error shown, so a broken payload that repeats every second shows one notice. */
  childrenError?: string;
  /** Waiting `/subagents-inspect-rpc` requests, by request id. */
  inspects: Map<string, (result: InspectResult) => void>;
}

/** How long a transcript request waits for pi-subagents' reply. */
const INSPECT_TIMEOUT_MS = 10_000;
/** Ids go into a slash command, so they must hold no spaces or newlines. */
const CHILD_ID = /^[A-Za-z0-9:_.-]{1,200}$/;

/** The text of a message's content: a string, or the text blocks of an array. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block as { type?: unknown; text?: unknown }).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
};

const asModel = (value: unknown): AgentModel | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== "string" || typeof raw.id !== "string") return undefined;
  return {
    provider: raw.provider,
    id: raw.id,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {}),
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    ...(Array.isArray(raw.input)
      ? { input: raw.input.filter((kind): kind is string => typeof kind === "string") }
      : {}),
  };
};

const asContextUsage = (value: unknown): ContextUsage | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.contextWindow !== "number") return undefined;
  return {
    tokens: typeof raw.tokens === "number" ? raw.tokens : null,
    contextWindow: raw.contextWindow,
    percent: typeof raw.percent === "number" ? raw.percent : null,
  };
};

/**
 * Runs workspace agents as `pi --mode rpc` processes (ADR 0002): at most `maxLive` at once (others wait in order),
 * stops idle ones after `idleStopMs` (ADR 0026), and keeps each agent's chat state for browser snapshots.
 */
export class AgentManager {
  private readonly agents = new Map<string, Live>();
  private readonly waiting: (() => void)[] = [];
  private readonly images: ChatImages;
  private inspectCount = 1;

  constructor(private readonly options: ManagerOptions) {
    this.images = new ChatImages(options.imageCacheBytes);
  }

  /** Registers an agent the store knows about. Idempotent. */
  track(record: AgentRecord): void {
    if (!this.agents.has(record.id)) {
      this.agents.set(record.id, {
        record,
        status: "stopped",
        since: record.createdAt,
        stopping: false,
        chat: emptyChat(),
        loaded: false,
        dialogs: new Map(),
        children: [],
        inspects: new Map(),
      });
    }
  }

  view(id: string): Agent {
    const live = this.get(id);
    const { record } = live;
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      role: record.role,
      kind: record.kind,
      active: record.active,
      ...(record.title === null ? {} : { title: record.title }),
      ...(record.forkedFrom === null ? {} : { forkedFrom: record.forkedFrom }),
      status: live.status,
      ...(live.error ? { error: live.error } : {}),
      createdAt: record.createdAt,
    };
  }

  /** The chats of a workspace. */
  chats(workspaceId: string): Agent[] {
    return [...this.agents.values()]
      .filter((live) => live.record.workspaceId === workspaceId)
      .map((live) => this.view(live.record.id));
  }

  rename(id: string, title: string): void {
    this.setTitle(this.get(id), title);
  }

  /**
   * Makes a chat able to run or turns it into read-only history (ADR 0030). Turning it off stops its process first,
   * and clears what Home shows about it: a failure or a reply waiting for the user. The caller writes the store.
   */
  async setActive(id: string, active: boolean): Promise<void> {
    const live = this.get(id);
    if (live.record.active === active) return;
    live.record.active = active;
    if (!active) {
      await this.stop(id);
      this.setWaiting(live, null);
      if (live.status === "failed") this.setStatus(live, "stopped");
    }
    this.publishChat(live);
  }

  isClosed(id: string): boolean {
    return this.get(id).record.closed;
  }

  /**
   * Closes a chat for good (ADR 0110): it stops, and Home forgets it. Other modules may still hold its id, so it
   * stays known. The caller writes the store and has checked that the chat is not working.
   */
  async close(id: string): Promise<void> {
    const live = this.get(id);
    live.record.closed = true;
    live.record.active = false;
    await this.stop(id);
    this.setWaiting(live, null);
    if (live.status === "failed") this.setStatus(live, "stopped");
    this.publishChat(live);
  }

  /** What Home needs about every open agent. */
  attention(): AgentAttention[] {
    return [...this.agents.values()]
      .filter((live) => !live.record.closed)
      .map((live) => ({
        agent: this.view(live.record.id),
        since: live.since,
        dialogs: [...live.dialogs.values()].map(({ dialog, openedAt }) => ({ dialog, openedAt })),
        ...(live.record.waitingSince === null ? {} : { waitingSince: live.record.waitingSince }),
      }));
  }

  /** The user has seen the agent's last reply: it no longer waits for them on Home. */
  seen(id: string): void {
    this.setWaiting(this.get(id), null);
  }

  /** The first events of a chat subscription. Opening the chat counts as seeing the agent's last reply. */
  async snapshot(id: string): Promise<AgentEvent[]> {
    const live = this.get(id);
    await this.loadHistory(live);
    this.setWaiting(live, null);
    return [this.snapshotEvent(live)];
  }

  private snapshotEvent(live: Live): AgentEvent {
    return {
      type: "snapshot",
      agent: this.view(live.record.id),
      ...(live.model ? { model: live.model } : {}),
      ...(live.thinkingLevel ? { thinkingLevel: live.thinkingLevel } : {}),
      ...(live.contextUsage ? { contextUsage: live.contextUsage } : {}),
      dialogs: [...live.dialogs.values()].map((entry) => entry.dialog),
      chat: live.chat,
      children: live.children,
    };
  }

  /**
   * Sends a user message, with images as Pi `ImageContent` blocks. While the agent works it goes in as `whileBusy`
   * (default steer).
   */
  async prompt(
    id: string,
    message: string,
    whileBusy: "steer" | "followUp" = "steer",
    images: readonly { type: "image"; data: string; mimeType: string }[] = [],
  ): Promise<string> {
    const live = this.get(id);
    const process = await this.ensureRunning(live);
    this.clearIdle(live);
    this.setWaiting(live, null);
    if (live.record.title === null) this.setTitle(live, chatTitle(message));
    const fields = {
      message,
      ...(images.length > 0 ? { images } : {}),
      ...(live.chat.busy ? { streamingBehavior: whileBusy } : {}),
    };
    const result = await process.request<{ disposition?: string }>("prompt", fields);
    return result?.disposition ?? "started";
  }

  /**
   * The bytes of an image this chat has shown, by its ref (ADR 0060). From memory, or else from the session file.
   * Undefined for a ref the chat never showed.
   */
  async image(id: string, ref: string): Promise<{ mimeType: string; bytes: Buffer } | undefined> {
    const live = this.get(id);
    await this.loadHistory(live);
    if (!this.images.knows(id, ref)) return undefined;
    const file = live.record.sessionFile;
    return this.images.read(ref, async () => (file ? (await readTranscript(file)).messages : []));
  }

  async abort(id: string): Promise<void> {
    const live = this.get(id);
    if (live.process?.alive) await live.process.request("abort", {}, 30_000);
  }

  async setModel(id: string, provider: string, modelId: string): Promise<AgentModel | undefined> {
    const live = this.get(id);
    const model = asModel(
      await (await this.ensureRunning(live)).request("set_model", { provider, modelId }),
    );
    if (model) live.model = model;
    this.publishModel(live);
    return live.model;
  }

  async setThinking(id: string, level: string): Promise<void> {
    const live = this.get(id);
    await (await this.ensureRunning(live)).request("set_thinking_level", { level });
    live.thinkingLevel = level;
    this.publishModel(live);
  }

  async compact(id: string): Promise<void> {
    const live = this.get(id);
    await (await this.ensureRunning(live)).request("compact", {}, 600_000);
    await this.refreshStats(live);
  }

  async models(id: string): Promise<{ models: AgentModel[]; thinkingLevels: string[] }> {
    const process = await this.ensureRunning(this.get(id));
    const [models, levels] = await Promise.all([
      process.request<{ models?: unknown[] }>("get_available_models"),
      process.request<{ levels?: unknown[] }>("get_available_thinking_levels"),
    ]);
    return {
      models: (models?.models ?? [])
        .map(asModel)
        .filter((model): model is AgentModel => model !== undefined),
      thinkingLevels: (levels?.levels ?? []).filter(
        (level): level is string => typeof level === "string",
      ),
    };
  }

  async commands(id: string): Promise<{ name: string; description?: string; source: string }[]> {
    const process = await this.ensureRunning(this.get(id));
    const result = await process.request<{ commands?: unknown[] }>("get_commands");
    return (result?.commands ?? []).flatMap((raw) => {
      const command = raw as { name?: unknown; description?: unknown; source?: unknown };
      if (typeof command.name !== "string") return [];
      return [
        {
          name: command.name,
          source: typeof command.source === "string" ? command.source : "unknown",
          ...(typeof command.description === "string" ? { description: command.description } : {}),
        },
      ];
    });
  }

  answerDialog(id: string, answer: DialogAnswer): void {
    const live = this.get(id);
    const entry = live.dialogs.get(answer.dialogId);
    if (!entry || !live.process?.alive) {
      throw new ApiError(409, "dialog_gone", "That dialog is no longer waiting for an answer");
    }
    live.process.answerDialog(answer);
    this.closeDialog(live, answer.dialogId);
  }

  /** Stops the agent's process. Its session file keeps the conversation. */
  async stop(id: string): Promise<void> {
    const live = this.agents.get(id);
    if (!live) return;
    this.clearIdle(live);
    const process =
      live.process ?? (live.starting ? await live.starting.catch(() => undefined) : undefined);
    if (!process?.alive) return;
    live.stopping = true;
    await process.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.stop(id)));
  }

  liveCount(): number {
    return this.othersLive(undefined);
  }

  /**
   * Background helpers that hold a runner process. They count against `maxLive` with the agent processes (ADR 0034).
   */
  runningChildren(): number {
    let count = 0;
    for (const live of this.agents.values()) count += runningCount(live.children);
    return count;
  }

  /**
   * What a helper's agent did, read from the agent's process with pi-subagents' `/subagents-inspect-rpc`. `childId`
   * picks one step of a run with several.
   */
  async childTranscript(id: string, runId: string, childId?: string): Promise<ChildTranscript> {
    const ids = childId === undefined ? [runId] : [runId, childId];
    if (!ids.every((value) => CHILD_ID.test(value))) {
      throw new ApiError(400, "bad_child_id", "A helper id has letters, digits, and : _ . - only");
    }
    const live = this.get(id);
    // Helpers are listed only while their agent's process runs (they are cleared when it exits).
    const process = live.process;
    if (!process?.alive || !live.children.some((run) => run.id === runId)) {
      throw new ApiError(404, "child_not_found", "This agent has no helper run with that id");
    }
    const requestId = `spore${this.inspectCount++}`;
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<InspectResult>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new ApiError(503, "inspect_timeout", "pi-subagents did not answer in time")),
        INSPECT_TIMEOUT_MS,
      );
      live.inspects.set(requestId, resolve);
    });
    // Nobody awaits it if the prompt below fails; the timeout must not become an unhandled rejection.
    reply.catch(() => undefined);
    try {
      // The reply may arrive before the prompt is answered; the waiter is already registered.
      await process.request("prompt", {
        message: `/subagents-inspect-rpc ${requestId} ${ids.join(" ")} --lines 50`,
      });
      const result = await reply;
      if (result.error) {
        const gone = result.error.code === "not_found" || result.error.code === "stale";
        throw new ApiError(
          gone ? 404 : 503,
          gone ? "child_not_found" : "inspect_failed",
          `pi-subagents: ${result.error.message}`,
        );
      }
      if (!result.transcript) throw new ApiError(503, "inspect_failed", "Empty reply");
      return result.transcript;
    } finally {
      clearTimeout(timer);
      live.inspects.delete(requestId);
    }
  }

  /** Agents with a running or starting process, other than `self`. */
  private othersLive(self: Live | undefined): number {
    let count = 0;
    for (const live of this.agents.values()) {
      if (live !== self && (live.process?.alive || live.starting)) count++;
    }
    return count;
  }

  private get(id: string): Live {
    const live = this.agents.get(id);
    if (!live) throw new ApiError(404, "agent_not_found", `No agent ${id}`);
    return live;
  }

  private publish(live: Live, event: AgentEvent): void {
    this.options.events.publish(`agent:${live.record.id}`, event);
  }

  private setStatus(live: Live, status: AgentStatus, error?: string): void {
    live.status = status;
    live.since = this.options.now();
    if (error === undefined) delete live.error;
    else live.error = error;
    this.publish(live, { type: "status", status, ...(error === undefined ? {} : { error }) });
    this.options.onChange(live.record.id, "status");
  }

  private setWaiting(live: Live, since: number | null): void {
    if (live.record.waitingSince === since) return;
    live.record.waitingSince = since;
    this.options.saveWaiting(live.record.id, since);
    this.options.onChange(live.record.id, "waiting");
  }

  private setTitle(live: Live, title: string): void {
    if (!title || live.record.title === title) return;
    live.record.title = title;
    this.options.saveTitle(live.record.id, title);
    this.publishChat(live);
  }

  private publishChat(live: Live): void {
    this.publish(live, { type: "agent", agent: this.view(live.record.id) });
    this.options.onChange(live.record.id, "chat");
  }

  private publishModel(live: Live): void {
    this.publish(live, {
      type: "model",
      ...(live.model ? { model: live.model } : {}),
      ...(live.thinkingLevel ? { thinkingLevel: live.thinkingLevel } : {}),
    });
  }

  /**
   * Reads what a stopped agent's page needs: its history from the session file, and the model it will run with
   * (the session's last selection, else the role default), so the page shows it before Pi starts.
   */
  private async loadHistory(live: Live): Promise<void> {
    if (live.loaded) return;
    if (live.record.sessionFile) {
      try {
        const transcript = await readTranscript(live.record.sessionFile);
        // Live events may have arrived already; keep them after the history.
        live.chat = this.images
          .strip(live.record.id, transcript.messages)
          .reduce((chat, message) => applyPiEvent(chat, { type: "message_end", message }), {
            ...emptyChat(),
            queue: live.chat.queue,
            busy: live.chat.busy,
          });
        if (!live.model && transcript.model) live.model = transcript.model;
        if (!live.thinkingLevel && transcript.thinkingLevel)
          live.thinkingLevel = transcript.thinkingLevel;
        // Chats from before titles existed. A side chat's history starts with its worker's messages, so it is left
        // to its own first message.
        const first = transcript.messages.find((message) => message.role === "user");
        if (live.record.title === null && live.record.forkedFrom === null && first)
          this.setTitle(live, chatTitle(textOf(first.content)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!live.model || !live.thinkingLevel) {
      const defaults = withModel(
        await this.options.roleDefaults(live.record.role),
        live.record.model,
      );
      if (!live.model && defaults.provider && defaults.modelId) {
        live.model = { provider: defaults.provider, id: defaults.modelId };
      }
      if (!live.thinkingLevel && defaults.thinking) live.thinkingLevel = defaults.thinking;
    }
    live.loaded = true;
  }

  private ensureRunning(live: Live): Promise<PiProcess> {
    if (live.process?.alive) return Promise.resolve(live.process);
    try {
      this.assertCanRun(live);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!live.starting) {
      live.starting = this.start(live).finally(() => {
        delete live.starting;
      });
    }
    return live.starting;
  }

  /** Only an active chat runs, and never two worker processes in one workspace (ADR 0030). */
  private assertCanRun(live: Live): void {
    const { record } = live;
    if (!record.active) {
      throw new ApiError(
        409,
        "chat_inactive",
        "This is an older orchestrator chat. It is read-only until you make it active again.",
      );
    }
    if (record.kind !== "worker") return;
    for (const other of this.agents.values()) {
      if (
        other !== live &&
        other.record.workspaceId === record.workspaceId &&
        other.record.kind === "worker" &&
        (other.process?.alive || other.starting)
      ) {
        throw new ApiError(
          409,
          "worker_running",
          "Another orchestrator chat of this workspace is still running. Stop it first.",
        );
      }
    }
  }

  /** Waits for a free live slot, in arrival order. */
  private async acquireSlot(live: Live): Promise<void> {
    while (this.othersLive(live) + this.runningChildren() >= this.options.maxLive) {
      if (live.status !== "waiting") this.setStatus(live, "waiting");
      const turn = new Promise<void>((resolve) => this.waiting.push(resolve));
      this.evictIdle();
      await turn;
    }
  }

  private releaseSlot(): void {
    this.waiting.shift()?.();
  }

  private async start(live: Live): Promise<PiProcess> {
    await this.acquireSlot(live);
    const { record } = live;
    const workspace = this.options.workspace(record.workspaceId);
    try {
      // The chat may have been switched off while it waited for a slot.
      this.assertCanRun(live);
    } catch (error) {
      this.releaseSlot();
      throw error;
    }
    if (workspace.state !== "active") {
      this.releaseSlot();
      throw new ApiError(
        409,
        "workspace_not_active",
        `The workspace is ${workspace.state}; resume it first`,
      );
    }
    this.setStatus(live, "starting");
    await this.loadHistory(live);

    let sessionArgs: string[];
    try {
      sessionArgs = await this.sessionArgs(live, workspace);
    } catch (error) {
      this.releaseSlot();
      this.setStatus(live, "failed", (error as Error).message);
      throw error;
    }
    const args = [...(await this.options.resourceArgs(workspace.path)), ...sessionArgs];
    const token = this.options.tokens.issue({
      agentId: record.id,
      workspaceId: workspace.id,
      ...(record.kind === "side" ? { readOnly: true } : {}),
    });
    const env = {
      ...(await this.options.env(record, workspace)),
      PI_SPORE_URL: this.options.url,
      PI_SPORE_TOKEN: token,
    };

    const process = new PiProcess(this.options.pi, {
      cwd: workspace.path,
      env,
      args,
      onEvent: (event) => this.onEvent(live, event),
      onDialog: (dialog, timeoutMs) => this.openDialog(live, dialog, timeoutMs),
      onNotice: (level, message) => this.publish(live, { type: "notice", level, message }),
      onChildRuns: (lines) => this.setChildren(live, lines),
      onInspectReply: (lines) => this.onInspectReply(live, lines),
      onExit: (code, signal) => this.onExit(live, process, code, signal),
    });
    live.process = process;
    live.token = token;
    live.stopping = false;

    let state: {
      model?: unknown;
      thinkingLevel?: unknown;
      sessionFile?: unknown;
      isStreaming?: unknown;
    };
    try {
      state = await process.request("get_state", {}, this.options.startTimeoutMs);
    } catch (error) {
      const tail = process.stderrTail();
      live.stopping = true;
      await process.stop(1_000);
      const message = `Pi did not start: ${(error as Error).message}${tail ? `\n${tail}` : ""}`;
      this.setStatus(live, "failed", message);
      throw new ApiError(503, "agent_start_failed", message);
    }

    const forked = record.sessionFile === null && record.forkedFrom !== null;
    if (typeof state.sessionFile === "string" && state.sessionFile !== record.sessionFile) {
      record.sessionFile = state.sessionFile;
      this.options.saveSessionFile(record.id, state.sessionFile);
    }
    if (forked) {
      // The first start of a side chat copied the worker's messages; open pages get them in a new snapshot.
      live.loaded = false;
      await this.loadHistory(live);
      this.publish(live, this.snapshotEvent(live));
    }
    const model = asModel(state.model);
    if (model) live.model = model;
    if (typeof state.thinkingLevel === "string") live.thinkingLevel = state.thinkingLevel;
    this.publishModel(live);
    this.setStatus(live, state.isStreaming === true ? "busy" : "idle");
    void this.refreshStats(live);
    this.armIdle(live);
    return process;
  }

  /**
   * `--session` to resume, after checking its folder exists (Pi hangs otherwise, spike Q1); `--fork` for the first
   * start of a side chat with its worker's context; or a new session. Side chats always get read-only tools.
   */
  private async sessionArgs(live: Live, workspace: Workspace): Promise<string[]> {
    const tools = live.record.kind === "side" ? SIDE_CHAT_TOOLS : [];
    return [...(await this.sessionFileArgs(live, workspace)), ...tools];
  }

  private async sessionFileArgs(live: Live, workspace: Workspace): Promise<string[]> {
    const file = live.record.sessionFile;
    const dir = join(this.options.sessionsDir, workspace.id);
    if (file && (await stat(file).catch(() => undefined))) {
      const { cwd } = await readTranscript(file);
      if (cwd && !(await stat(cwd).catch(() => undefined))) {
        throw new ApiError(
          409,
          "session_folder_missing",
          `This chat ran in ${cwd}, which no longer exists. Its history is still readable.`,
        );
      }
      return ["--session", file];
    }
    if (live.record.forkedFrom !== null) {
      // The copy keeps the worker's model, so no role model is forced on it.
      const source = this.agents.get(live.record.forkedFrom)?.record.sessionFile;
      if (!source || !(await stat(source).catch(() => undefined))) {
        throw new ApiError(
          409,
          "fork_source_missing",
          "The orchestrator chat this side chat copies has no session file anymore.",
        );
      }
      return ["--fork", source, "--session-dir", dir];
    }
    const role = modelArgs(
      withModel(await this.options.roleDefaults(live.record.role), live.record.model),
    );
    return ["--session-dir", dir, ...role];
  }

  private onEvent(live: Live, raw: Record<string, unknown>): void {
    // Image data stays on the server; pages fetch it by ref (ADR 0060).
    const event = this.images.strip(live.record.id, raw);
    live.chat = applyPiEvent(live.chat, event);
    this.publish(live, { type: "pi", event });
    if (event.type === "agent_start") {
      this.clearIdle(live);
      this.setStatus(live, "busy");
    } else if (event.type === "agent_settled") {
      if (event.aborted !== true) this.setWaiting(live, this.options.now());
      this.setStatus(live, "idle");
      void this.refreshStats(live);
      this.armIdle(live);
    } else if (event.type === "thinking_level_changed" && typeof event.level === "string") {
      live.thinkingLevel = event.level;
      this.publishModel(live);
    }
  }

  /** Takes the agent's latest helper list. Only a change a page shows is published (the widget repeats each second). */
  private setChildren(live: Live, lines: unknown): void {
    let children: ChildRun[];
    try {
      children = parseChildRuns(lines);
    } catch (error) {
      const message = `Helper runs are not shown: ${(error as Error).message}`;
      if (live.childrenError !== message) {
        live.childrenError = message;
        this.options.log.error("pi-subagents status not understood", {
          agent: live.record.id,
          error: (error as Error).message,
        });
        this.publish(live, { type: "notice", level: "error", message });
      }
      return;
    }
    delete live.childrenError;
    if (JSON.stringify(children) === JSON.stringify(live.children)) return;
    const before = runningCount(live.children);
    live.children = children;
    this.publish(live, { type: "children", children });
    if (runningCount(children) < before) this.releaseSlot();
    // An agent kept alive by a helper may be idle now.
    if (live.status === "idle") this.armIdle(live);
  }

  private onInspectReply(live: Live, lines: unknown): void {
    let result: InspectResult;
    try {
      result = parseInspectReply(lines);
    } catch (error) {
      this.options.log.error("pi-subagents inspect reply not understood", {
        agent: live.record.id,
        error: (error as Error).message,
      });
      return;
    }
    live.inspects.get(result.requestId)?.(result);
  }

  private openDialog(live: Live, dialog: AgentDialog, timeoutMs: number | undefined): void {
    this.clearIdle(live);
    // Pi answers a timed-out dialog by itself; drop it from the page at the same time.
    const timer = timeoutMs
      ? setTimeout(() => this.closeDialog(live, dialog.id), timeoutMs)
      : undefined;
    live.dialogs.set(dialog.id, {
      dialog,
      openedAt: this.options.now(),
      ...(timer ? { timer } : {}),
    });
    this.publish(live, { type: "dialog", dialog });
    this.options.onChange(live.record.id, "dialog");
  }

  private closeDialog(live: Live, dialogId: string): void {
    const entry = live.dialogs.get(dialogId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    live.dialogs.delete(dialogId);
    this.publish(live, { type: "dialog_closed", dialogId });
    this.options.onChange(live.record.id, "dialog");
    this.armIdle(live);
  }

  private onExit(live: Live, process: PiProcess, code: number | null, signal: string | null): void {
    if (live.process !== process) return;
    this.clearIdle(live);
    delete live.process;
    // The helpers' status came from this process. Their runners may live on, but nothing reports them now.
    if (live.children.length > 0) {
      live.children = [];
      this.publish(live, { type: "children", children: [] });
    }
    live.inspects.clear();
    if (live.token) this.options.tokens.revoke(live.token);
    delete live.token;
    live.chat = { ...live.chat, busy: false, running: [] };
    if (live.chat.streaming) {
      const { streaming: _lost, ...rest } = live.chat;
      live.chat = rest;
    }
    for (const dialogId of [...live.dialogs.keys()]) this.closeDialog(live, dialogId);
    if (live.stopping) this.setStatus(live, "stopped");
    else {
      const tail = process.stderrTail();
      const error = `Pi exited unexpectedly (${code !== null ? `code ${code}` : signal})${tail ? `\n${tail}` : ""}`;
      this.options.log.error("Agent process exited", { agent: live.record.id, code, signal });
      this.setStatus(live, "failed", error);
    }
    live.stopping = false;
    this.releaseSlot();
  }

  private async refreshStats(live: Live): Promise<void> {
    if (!live.process?.alive) return;
    try {
      const stats = await live.process.request<{ contextUsage?: unknown }>(
        "get_session_stats",
        {},
        10_000,
      );
      const usage = asContextUsage(stats?.contextUsage);
      if (usage) live.contextUsage = usage;
      else delete live.contextUsage;
      this.publish(live, { type: "stats", ...(usage ? { contextUsage: usage } : {}) });
    } catch {
      // Stats are a display nicety; a failure here must not fail the run.
    }
  }

  /** Starts the idle clock when nothing is running, queued, or waiting for an answer (ADR 0026). */
  private armIdle(live: Live): void {
    this.clearIdle(live);
    if (!this.isIdle(live)) return;
    live.idleTimer = setTimeout(() => void this.stop(live.record.id), this.options.idleStopMs);
    live.idleTimer.unref();
    this.evictIdle();
  }

  private isIdle(live: Live): boolean {
    const queued = live.chat.queue.steering.length + live.chat.queue.followUp.length;
    if (!live.process?.alive || live.chat.busy || queued > 0 || live.dialogs.size > 0) return false;
    // A running helper delivers its result to this process (ADR 0034).
    return runningCount(live.children) === 0;
  }

  /**
   * Stops idle agents, longest idle first, so waiting chats can start. A stopped chat restarts in about 1 s,
   * so idleness must not block work (ADR 0026). Agents already stopping count as slots on their way.
   */
  private evictIdle(): void {
    let freeing = 0;
    const candidates: Live[] = [];
    for (const live of this.agents.values()) {
      if (live.stopping && live.process?.alive) freeing++;
      else if (this.isIdle(live)) candidates.push(live);
    }
    candidates.sort((a, b) => a.since - b.since);
    for (const live of candidates.slice(0, Math.max(0, this.waiting.length - freeing))) {
      void this.stop(live.record.id);
    }
  }

  private clearIdle(live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    delete live.idleTimer;
  }
}
