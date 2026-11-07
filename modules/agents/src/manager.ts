import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type AgentTokens, ApiError, type EventHub, type Logger } from "@pi-spore/module-api";
import {
  type Agent,
  type AgentDialog,
  type AgentModel,
  type AgentStatus,
  applyPiEvent,
  type ChatState,
  type ContextUsage,
  type DialogAnswer,
  emptyChat,
  type Workspace,
} from "@pi-spore/shared";
import type { AgentAttention } from "./contract.js";
import { modelArgs, type RoleDefaults } from "./launch.js";
import { type PiCommand, PiProcess } from "./rpc.js";
import { readTranscript } from "./transcript.js";

export interface AgentRecord {
  id: string;
  workspaceId: string;
  role: "worker";
  sessionFile: string | null;
  createdAt: number;
  /** When the last run ended and the agent began to wait for the user, or null. */
  waitingSince: number | null;
}

export type AgentChange = "status" | "dialog" | "waiting";

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
  /** Called after a status, dialog, or waiting change, for Home and deliveries. */
  onChange(agentId: string, change: AgentChange): void;
  maxLive: number;
  idleStopMs: number;
  startTimeoutMs: number;
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
    }
  | { type: "pi"; event: unknown }
  | { type: "status"; status: AgentStatus; error?: string }
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
}

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

  constructor(private readonly options: ManagerOptions) {}

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
      });
    }
  }

  view(id: string): Agent {
    const live = this.get(id);
    return {
      id: live.record.id,
      workspaceId: live.record.workspaceId,
      role: live.record.role,
      status: live.status,
      ...(live.error ? { error: live.error } : {}),
      createdAt: live.record.createdAt,
    };
  }

  /** What Home needs about every agent. */
  attention(): AgentAttention[] {
    return [...this.agents.values()].map((live) => ({
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
    return [
      {
        type: "snapshot",
        agent: this.view(id),
        ...(live.model ? { model: live.model } : {}),
        ...(live.thinkingLevel ? { thinkingLevel: live.thinkingLevel } : {}),
        ...(live.contextUsage ? { contextUsage: live.contextUsage } : {}),
        dialogs: [...live.dialogs.values()].map((entry) => entry.dialog),
        chat: live.chat,
      },
    ];
  }

  /** Sends a user message. While the agent works it goes in as `whileBusy` (default steer). */
  async prompt(
    id: string,
    message: string,
    whileBusy: "steer" | "followUp" = "steer",
  ): Promise<string> {
    const live = this.get(id);
    const process = await this.ensureRunning(live);
    this.clearIdle(live);
    this.setWaiting(live, null);
    const fields = live.chat.busy ? { message, streamingBehavior: whileBusy } : { message };
    const result = await process.request<{ disposition?: string }>("prompt", fields);
    return result?.disposition ?? "started";
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
        live.chat = transcript.messages.reduce(
          (chat, message) => applyPiEvent(chat, { type: "message_end", message }),
          { ...emptyChat(), queue: live.chat.queue, busy: live.chat.busy },
        );
        if (!live.model && transcript.model) live.model = transcript.model;
        if (!live.thinkingLevel && transcript.thinkingLevel)
          live.thinkingLevel = transcript.thinkingLevel;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!live.model || !live.thinkingLevel) {
      const defaults = await this.options.roleDefaults(live.record.role);
      if (!live.model && defaults.provider && defaults.modelId) {
        live.model = { provider: defaults.provider, id: defaults.modelId };
      }
      if (!live.thinkingLevel && defaults.thinking) live.thinkingLevel = defaults.thinking;
    }
    live.loaded = true;
  }

  private ensureRunning(live: Live): Promise<PiProcess> {
    if (live.process?.alive) return Promise.resolve(live.process);
    if (!live.starting) {
      live.starting = this.start(live).finally(() => {
        delete live.starting;
      });
    }
    return live.starting;
  }

  /** Waits for a free live slot, in arrival order. */
  private async acquireSlot(live: Live): Promise<void> {
    while (this.othersLive(live) >= this.options.maxLive) {
      if (live.status !== "waiting") this.setStatus(live, "waiting");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  private releaseSlot(): void {
    this.waiting.shift()?.();
  }

  private async start(live: Live): Promise<PiProcess> {
    await this.acquireSlot(live);
    const { record } = live;
    const workspace = this.options.workspace(record.workspaceId);
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
    const token = this.options.tokens.issue({ agentId: record.id, workspaceId: workspace.id });
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

    if (typeof state.sessionFile === "string" && state.sessionFile !== record.sessionFile) {
      record.sessionFile = state.sessionFile;
      this.options.saveSessionFile(record.id, state.sessionFile);
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

  /** `--session` to resume, after checking its folder exists (Pi hangs otherwise, spike Q1), or a new session. */
  private async sessionArgs(live: Live, workspace: Workspace): Promise<string[]> {
    const file = live.record.sessionFile;
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
    const role = modelArgs(await this.options.roleDefaults(live.record.role));
    return ["--session-dir", join(this.options.sessionsDir, workspace.id), ...role];
  }

  private onEvent(live: Live, event: Record<string, unknown>): void {
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
    const queued = live.chat.queue.steering.length + live.chat.queue.followUp.length;
    if (!live.process?.alive || live.chat.busy || queued > 0 || live.dialogs.size > 0) return;
    live.idleTimer = setTimeout(() => void this.stop(live.record.id), this.options.idleStopMs);
    live.idleTimer.unref();
  }

  private clearIdle(live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    delete live.idleTimer;
  }
}
