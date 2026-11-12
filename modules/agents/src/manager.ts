import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pid } from "node:process";
import { type AgentTokens, ApiError, type EventHub, type Logger } from "@pi-spore/module-api";
import {
  type Agent,
  type AgentDialog,
  type AgentModel,
  type AgentRole,
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
  ModelChoices,
  parse,
  type Workspace,
} from "@pi-spore/shared";
import {
  type InspectResult,
  parseChildRuns,
  parseInspectReply,
  runningCount,
} from "./child-runs.js";
import type { AgentAttention, AgentChange, LaunchContext } from "./contract.js";
import { ChatImages } from "./images.js";
import {
  modelArgs,
  PLANNER_CHAT_TOOLS,
  type RoleDefaults,
  SIDE_CHAT_TOOLS,
  STAGE_REVIEWER_TOOLS,
  withModel,
} from "./launch.js";
import { type PiCommand, PiProcess } from "./rpc.js";
import { readTranscript, type Transcript } from "./transcript.js";

export interface AgentRecord {
  id: string;
  workspaceId: string;
  role: AgentRole;
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
  /** The thinking level a new session starts on, or null for the role's default (ADR 0175). */
  thinking: string | null;
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
  /** What the modules' launch hooks add to one launch, merged (`addLaunchContext`). */
  launchContext(agent: Agent, workspace: Workspace): LaunchContext;
  /** The server's base URL, which spore-bridge calls. */
  url: string;
  /** Issues each process its own bridge token, revoked when the process exits. */
  tokens: AgentTokens;
  now: () => number;
  workspace(id: string): Workspace;
  saveSessionFile(agentId: string, file: string): void;
  /**
   * A model or thinking level the user picked while the chat had no session file on disk. The next new session
   * starts on it (ADR 0175).
   */
  saveModel(agentId: string, model: string): void;
  saveThinking(agentId: string, level: string): void;
  saveWaiting(agentId: string, since: number | null): void;
  saveTitle(agentId: string, title: string): void;
  /** Called after a status, dialog, or waiting change, for Home and deliveries. */
  onChange(agentId: string, change: AgentChange): void;
  maxLive: number;
  idleStopMs: number;
  startTimeoutMs: number;
  /** How long a model list from `availableModels()` stays valid. */
  modelsCacheMs: number;
  /** How to launch the short-lived Pi process that lists models when no chat runs (ADR 0120). */
  probe(): Promise<{ cwd: string; env: Record<string, string>; args: string[] }>;
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
  /** "Waiting for <model>" while the router holds the next request for a busy local model (R4.5). */
  routerStatus?: string;
  /** What the agent waits on while idle, from `setWorkingFor`. */
  workingFor?: string;
  /** The last payload error shown, so a broken payload that repeats every second shows one notice. */
  childrenError?: string;
  /** Waiting `/subagents-inspect-rpc` requests, by request id. */
  inspects: Map<string, (result: InspectResult) => void>;
  /**
   * One token per user prompt from just before it is sent until its run's `agent_start`: Pi may have taken it and
   * not started. A prompt that starts no run removes only its own token. `agent_start` and `agent_settled` clear all:
   * their line can come before the continuation of a prompt Pi answered "started", so a token kept there could stay.
   */
  unstarted: Set<symbol>;
}

/**
 * Whether the agent's bridge token is read-only and its tools are an allowlist. Side chats and planner chats are
 * (ADR 0174); so are the reviewer stage roles. The pipeline checks their work, so they must not change files or run
 * commands (R6).
 */
const isReadOnly = ({ kind, role }: AgentRecord): boolean =>
  kind === "side" || role === "planner" || (kind === "stage" && role !== "worker");

/**
 * The tool arguments of an agent: a stage worker and a workspace chat get Pi's normal tools. A launch hook's tools
 * replace them, except for a planner chat, which is read-only whatever a hook says.
 */
const toolArgs = (record: AgentRecord, tools?: readonly string[]): readonly string[] => {
  if (record.role === "planner") {
    if (tools) throw new Error(`A launch hook gave tools to planner chat ${record.id}`);
    return PLANNER_CHAT_TOOLS;
  }
  if (tools) return ["--tools", tools.join(","), "--exclude-tools", "mcp__*"];
  if (record.kind === "side") return SIDE_CHAT_TOOLS;
  if (record.kind === "stage" && record.role !== "worker") return STAGE_REVIEWER_TOOLS;
  return [];
};

/**
 * Whether the chat's session file is on disk. Pi reports the path when it starts and writes the file only at its
 * first assistant message, so a chat can have a path and no file yet (ADR 0175).
 */
const hasSessionFile = async (file: string | null): Promise<boolean> =>
  file !== null && (await stat(file).catch(() => undefined)) !== undefined;

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
/**
 * The messages Pi has written to a session file. Pi names the file before its first reply writes it, so a missing
 * file means no turn has ended yet.
 */
const writtenMessages = async (file: string | null): Promise<Transcript["messages"]> => {
  if (!file) return [];
  try {
    return (await readTranscript(file)).messages;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export class AgentManager {
  private readonly agents = new Map<string, Live>();
  private readonly waiting: (() => void)[] = [];
  private readonly images: ChatImages;
  private inspectCount = 1;
  /** Model-list processes now running. They hold a slot like a chat does. */
  private probes = 0;
  private modelCache: { at: number; models: AgentModel[] } | undefined;
  private modelsInFlight: Promise<AgentModel[]> | undefined;

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
        unstarted: new Set(),
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
      ...(runningCount(live.children) > 0 ? { helpersRunning: runningCount(live.children) } : {}),
      ...(live.workingFor ? { workingFor: live.workingFor } : {}),
      ...(live.routerStatus ? { routerStatus: live.routerStatus } : {}),
      createdAt: record.createdAt,
    };
  }

  setWorkingFor(id: string, label: string | undefined): void {
    const live = this.get(id);
    if (live.workingFor === label) return;
    if (label === undefined) delete live.workingFor;
    else live.workingFor = label;
    // An open chat page follows `agent:<id>`, not `agents:list`.
    this.publish(live, { type: "agent", agent: this.view(id) });
    this.options.onChange(id, "working");
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

  /**
   * Deletes a chat from memory for retention (ADR 0121): it stops, drops its caches, and pages forget it. The caller
   * deletes the store rows and files. Unlike `close`, the id answers 404 afterwards.
   */
  async forget(id: string): Promise<void> {
    const live = this.get(id);
    await this.stop(id);
    for (const dialogId of [...live.dialogs.keys()]) this.closeDialog(live, dialogId);
    this.agents.delete(id);
    this.images.forget(id);
    this.options.events.publish("agents:list", { type: "removed", id });
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
    // Pi 1.5.0 removes a queued steer on delivery by its text, and only when that text is not empty
    // (`@earendil-works/pi-coding-agent/dist/core/agent-session.js` ~746), so a picture-only steer stays queued
    // forever. A placeholder text works around it; drop this once Pi removes empty queue entries too. Only a queued
    // message gets it, so a picture-only first message keeps its empty text and the chat stays untitled.
    const piMessage =
      live.chat.busy && images.length > 0 && message.trim() === ""
        ? `(${images.length > 1 ? "images" : "image"})`
        : message;
    const fields = {
      message: piMessage,
      ...(images.length > 0 ? { images } : {}),
      ...(live.chat.busy ? { streamingBehavior: whileBusy } : {}),
    };
    const token = Symbol("prompt");
    live.unstarted.add(token);
    let result: { disposition?: string } | undefined;
    try {
      result = await process.request<{ disposition?: string }>("prompt", fields);
    } catch (error) {
      live.unstarted.delete(token);
      throw error;
    }
    const disposition = result?.disposition ?? "started";
    // Only a started run sends the `agent_start` that clears it; a command or a queued message never does.
    if (disposition !== "started") live.unstarted.delete(token);
    return disposition;
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

  roleDefaults(role: string): Promise<RoleDefaults> {
    return this.options.roleDefaults(role);
  }

  /**
   * The physical models Pi recorded on the agent's assistant messages (a virtual model such as `spore/auto` answers
   * through another one, ADR 0009), in first-seen order. The session file is the record, so this works for a stopped
   * agent too.
   */
  async modelsUsed(id: string): Promise<string[]> {
    const used = new Set<string>();
    for (const message of await writtenMessages(this.get(id).record.sessionFile)) {
      if (
        message.role === "assistant" &&
        typeof message.provider === "string" &&
        typeof message.model === "string"
      ) {
        used.add(`${message.provider}/${message.model}`);
      }
    }
    return [...used];
  }

  async turnError(id: string): Promise<string | undefined> {
    const { status, error, record } = this.get(id);
    if (status === "failed") return error;
    if (status === "busy" || status === "starting" || status === "waiting") return undefined;
    const last = (await writtenMessages(record.sessionFile)).findLast(
      (message) => message.role === "assistant",
    );
    if (last?.stopReason !== "error") return undefined;
    return typeof last.errorMessage === "string"
      ? last.errorMessage
      : "the model returned an error";
  }

  /** True when the agent is idle and its last assistant message ended on its own; see `Agents.endedRun`. */
  async endedRun(id: string): Promise<boolean> {
    const live = this.get(id);
    const last = (await writtenMessages(live.record.sessionFile)).findLast(
      (message) => message.role === "assistant",
    );
    return (
      live.status === "idle" &&
      live.unstarted.size === 0 &&
      last !== undefined &&
      last.stopReason !== "error" &&
      last.stopReason !== "aborted"
    );
  }

  async setModel(id: string, provider: string, modelId: string): Promise<AgentModel | undefined> {
    const live = this.get(id);
    // The pipeline judges a stage by the model it ran on (R4.4), so the model is fixed at creation.
    if (live.record.kind === "stage") {
      throw new ApiError(
        409,
        "stage_model_fixed",
        "A pipeline stage keeps the model it started with",
      );
    }
    const model = asModel(
      await (await this.ensureRunning(live)).request("set_model", { provider, modelId }),
    );
    if (model) live.model = model;
    // With no session file yet, the next launch starts a new session on the role default, so keep the pick on the
    // row. A resumed session carries its own model (ADR 0175).
    if (!(await hasSessionFile(live.record.sessionFile))) {
      live.record.model = `${provider}/${modelId}`;
      this.options.saveModel(live.record.id, live.record.model);
    }
    this.publishModel(live);
    return live.model;
  }

  async setThinking(id: string, level: string): Promise<void> {
    const live = this.get(id);
    await (await this.ensureRunning(live)).request("set_thinking_level", { level });
    live.thinkingLevel = level;
    if (!(await hasSessionFile(live.record.sessionFile))) {
      live.record.thinking = level;
      this.options.saveThinking(live.record.id, level);
    }
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
    return this.othersLive(undefined) + this.probes;
  }

  /** The models Pi offers, with no chat needed. Cached, and one process at a time (ADR 0120). */
  availableModels(): Promise<AgentModel[]> {
    const cached = this.modelCache;
    if (cached && this.options.now() - cached.at < this.options.modelsCacheMs)
      return Promise.resolve(cached.models);
    this.modelsInFlight ??= this.probeModels().finally(() => {
      this.modelsInFlight = undefined;
    });
    return this.modelsInFlight;
  }

  private async probeModels(): Promise<AgentModel[]> {
    await this.acquireSlot();
    this.probes++;
    try {
      const { cwd, env, args } = await this.options.probe();
      const process = new PiProcess(this.options.pi, {
        cwd,
        env,
        args,
        onEvent: () => {},
        onDialog: () => {},
        onNotice: () => {},
        onChildRuns: () => {},
        onRouterStatus: () => {},
        onInspectReply: () => {},
        onExit: () => {},
      });
      try {
        const data = await process.request("get_available_models", {}, this.options.startTimeoutMs);
        const { models } = parse(ModelChoices, data, "Pi model list");
        this.modelCache = { at: this.options.now(), models };
        return models;
      } catch (error) {
        const tail = process.stderrTail();
        throw new ApiError(
          502,
          "models_unavailable",
          `Could not list models: ${(error as Error).message}${tail ? `\n${tail}` : ""}`,
        );
      } finally {
        await process.stop(1_000);
      }
    } finally {
      this.probes--;
      this.releaseSlot();
    }
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
        live.record.thinking,
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
  private async acquireSlot(live?: Live): Promise<void> {
    while (this.othersLive(live) + this.probes + this.runningChildren() >= this.options.maxLive) {
      if (live && live.status !== "waiting") this.setStatus(live, "waiting");
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
    let context: LaunchContext;
    try {
      context = this.options.launchContext(this.view(record.id), workspace);
      sessionArgs = await this.sessionArgs(live, workspace, context.tools);
    } catch (error) {
      this.releaseSlot();
      this.setStatus(live, "failed", (error as Error).message);
      throw error;
    }
    const args = [...(await this.options.resourceArgs(workspace.path)), ...sessionArgs];
    const token = this.options.tokens.issue({
      agentId: record.id,
      workspaceId: workspace.id,
      ...(isReadOnly(record) ? { readOnly: true } : {}),
    });
    const env = {
      ...(await this.options.env(record, workspace)),
      ...context.env,
      PI_SPORE_URL: this.options.url,
      PI_SPORE_SERVER_PID: String(pid),
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
      onRouterStatus: (text) => this.setRouterStatus(live, text),
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
   * start of a side chat with its worker's context; or a new session. Side chats and reviewer stages always get
   * read-only tools.
   */
  private async sessionArgs(
    live: Live,
    workspace: Workspace,
    tools?: readonly string[],
  ): Promise<string[]> {
    return [...(await this.sessionFileArgs(live, workspace)), ...toolArgs(live.record, tools)];
  }

  private async sessionFileArgs(live: Live, workspace: Workspace): Promise<string[]> {
    const file = live.record.sessionFile;
    const dir = join(this.options.sessionsDir, workspace.id);
    if (file && (await hasSessionFile(file))) {
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
      withModel(
        await this.options.roleDefaults(live.record.role),
        live.record.model,
        live.record.thinking,
      ),
    );
    return ["--session-dir", dir, ...role];
  }

  private onEvent(live: Live, raw: Record<string, unknown>): void {
    // Image data stays on the server; pages fetch it by ref (ADR 0060).
    const event = this.images.strip(live.record.id, raw);
    live.chat = applyPiEvent(live.chat, event);
    this.publish(live, { type: "pi", event });
    if (event.type === "agent_start") {
      live.unstarted.clear();
      this.clearIdle(live);
      this.setStatus(live, "busy");
    } else if (event.type === "agent_settled") {
      live.unstarted.clear();
      this.setRouterStatus(live, undefined);
      if (event.aborted !== true) this.setWaiting(live, this.options.now());
      this.setStatus(live, "idle");
      void this.refreshStats(live);
      this.armIdle(live);
    } else if (event.type === "thinking_level_changed" && typeof event.level === "string") {
      live.thinkingLevel = event.level;
      this.publishModel(live);
    }
  }

  private setRouterStatus(live: Live, text: string | undefined): void {
    if (live.routerStatus === text) return;
    if (text === undefined) delete live.routerStatus;
    else live.routerStatus = text;
    this.publishChat(live);
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
    if (runningCount(children) !== before) this.options.onChange(live.record.id, "helpers");
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
    live.unstarted.clear();
    delete live.process;
    // The helpers' status came from this process. Their runners may live on, but nothing reports them now.
    if (live.children.length > 0) {
      live.children = [];
      this.publish(live, { type: "children", children: [] });
    }
    live.inspects.clear();
    this.setRouterStatus(live, undefined);
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
