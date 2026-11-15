/**
 * The planner chat and the run coordinator start read-only helpers (ADR 0176). They have no `subagent` tool, which
 * could start a writing `worker`, so this file gives them one narrow tool, `start_helper`, built on pi-subagents'
 * in-process RPC, and a capability ceiling that keeps those helpers and their children read-only.
 */
import { randomUUID } from "node:crypto";
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";
import Type from "typebox";
import { Check, Errors } from "typebox/value";
import type { BridgeEnv } from "./client.js";

/** The only agents these chats may start. A `worker` writes files, so it stays out (ADR 0176). */
const HELPERS = ["scout", "researcher"] as const;

/**
 * What those agents and their children may use. The built-in `scout` also has `bash` and `write`, so without this a
 * helper started from a read-only chat could change that chat's folder (spike answer 1).
 */
const HELPER_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
];

/** pi-subagents answers this on the bus inside its own `session_start`, and takes one request per channel. */
const READY = "subagents:rpc:v1:ready";
const REQUEST = "subagents:rpc:v1:request";
const replyChannel = (requestId: string) => `subagents:rpc:v1:reply:${requestId}`;

/** How long one spawn request may wait for pi-subagents. */
const REPLY_MS = 10_000;

const NOT_LOADED =
  "start_helper needs the pi-subagents Pi package, and it is not loaded in this chat.";

const CANCELLED = "start_helper was cancelled before it asked pi-subagents to start the helper.";

/** What pi-subagents answers a request with. Anything else is a reply this tool cannot read. */
const SpawnAnswer = Type.Union([
  Type.Object({
    success: Type.Literal(true),
    data: Type.Object({ details: Type.Object({ runId: Type.String({ minLength: 1 }) }) }),
  }),
  Type.Object({
    success: Type.Literal(false),
    error: Type.Object({ code: Type.String(), message: Type.String() }),
  }),
]);

const text = (value: string) => [{ type: "text" as const, text: value }];

/** The reply that arrived, or why the wait ended without one. */
type Wait<T> = { status: "reply"; value: T } | { status: "timeout" } | { status: "aborted" };

/**
 * Resolves with the first value sent to `channel`, or with `timeout` or `aborted`. It always drops the listener and
 * the timer, so a late answer reaches nothing and no wait outlives its tool call.
 */
function wait<T>(
  events: EventBus,
  channel: string,
  signal: AbortSignal | undefined,
): Promise<Wait<T>> {
  return new Promise<Wait<T>>((resolve) => {
    let settled = false;
    let unsubscribe = (): void => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: Wait<T>): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => settle({ status: "aborted" });
    unsubscribe = events.on(channel, (data) => settle({ status: "reply", value: data as T }));
    timer = setTimeout(() => settle({ status: "timeout" }), REPLY_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Registers `start_helper` and the session's capability ceiling, in a planner chat and in a run coordinator only.
 * It needs no bridge client: the helper runs in this Pi process, not on the pi-spore server.
 */
export function registerHelperTool(pi: ExtensionAPI, env: BridgeEnv): void {
  if (env.chatKind !== "planner" && env.runRole !== "coordinator") return;

  // pi-subagents emits ready in its own `session_start`, so this listener has to exist before that handler runs.
  let ready = false;
  pi.events.on(READY, () => {
    ready = true;
  });

  let ceiling: SubagentCapabilityCeilingHandle | undefined;
  pi.on("session_start", (_event, ctx) => {
    // A reload or a new session has a new session id: a ceiling must not outlive the chat that set it.
    ceiling?.dispose();
    ceiling = registerSubagentCapabilityCeiling({
      sessionId: ctx.sessionManager.getSessionId(),
      source: "pi-spore",
      ceiling: { allowedAgents: HELPERS, allowedTools: HELPER_TOOLS },
    });
  });
  pi.on("session_shutdown", () => {
    ceiling?.dispose();
    ceiling = undefined;
  });

  pi.registerTool({
    name: "start_helper",
    label: "Start helper",
    description:
      "Start a read-only scout or researcher in the background. Use scout for questions about this repository " +
      "and researcher for facts from outside it. The helper only reads. Its result comes back to this chat as a " +
      "message, so do not poll for it.",
    promptSnippet: "Start a read-only scout or researcher in the background",
    promptGuidelines: [
      "Start helpers with start_helper before you read deeply: `scout` for where a thing lives, how a part works, and what calls what; `researcher` for library docs, versions, and APIs. Give each one a clear question and the paths or sources to start from.",
      "Helpers only read; they cannot change files or run commands. Each result comes back to this chat as a message, so do not poll for it. Start another round only if the first is not enough.",
    ],
    parameters: Type.Object({
      agent: Type.Enum(HELPERS, {
        description:
          "scout answers questions about this repository; researcher answers questions about facts outside it",
      }),
      task: Type.String({
        minLength: 1,
        description: "The question for the helper, with the paths or sources to start from",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ready) throw new Error(NOT_LOADED);
      // A call the user stopped before it dispatched must not start a run nobody is waiting for.
      if (signal?.aborted) throw new Error(CANCELLED);
      const requestId = randomUUID();
      // Subscribe before the request: pi-subagents answers in about 30 ms, and a reply with no listener is lost.
      const pending = wait<unknown>(pi.events, replyChannel(requestId), signal);
      pi.events.emit(REQUEST, {
        version: 1,
        requestId,
        method: "spawn",
        // `spawn` starts a background run only, so a helper never holds this chat's turn open (ADR 0176).
        params: { agent: params.agent, task: params.task, context: "fresh", cwd: ctx.cwd },
      });

      const answer = await pending;
      if (answer.status === "timeout")
        throw new Error(`pi-subagents did not answer the spawn request in ${REPLY_MS / 1000} s.`);
      if (answer.status === "aborted")
        throw new Error(`start_helper stopped waiting for pi-subagents (request ${requestId}).`);

      const reply = answer.value;
      if (Check(SpawnAnswer, reply)) {
        // A thrown message is what the model reads, so a refused spawn keeps pi-subagents' own words.
        if (reply.success === false) throw new Error(`${reply.error.code}: ${reply.error.message}`);
        const { runId } = reply.data.details;
        return {
          // pi-subagents' own text names the `subagent` tool, which these chats do not have.
          content: text(
            `Started ${params.agent} in the background (run ${runId}). Its result comes back to this chat as a message. Do not poll for it.`,
          ),
          details: { runId },
        };
      }
      const why = Errors(SpawnAnswer, reply)
        .slice(0, 3)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`)
        .join("; ");
      throw new Error(
        `pi-subagents sent a reply to the spawn request that start_helper cannot read: ${why}`,
      );
    },
  });
}
