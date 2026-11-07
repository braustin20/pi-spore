/**
 * spore-bridge: the workbench tools of pi-spore agents (architecture 2). pi-spore loads it into every agent with
 * `-e`, with `PI_SPORE_URL` and an agent token in the environment. Outside pi-spore it adds nothing and says so.
 */
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { registerCardTools } from "./cards.js";
import {
  BridgeClient,
  type BridgeEnv,
  bridgeEnv,
  LogAnswer,
  QuestionAnswer,
  type Run,
  RunAnswer,
} from "./client.js";
import { applyRules } from "./rules.js";

/** How long one wait for a run may hold a request; the server caps it at 30 s. */
const WAIT_MS = 25_000;
const ENDED = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

const text = (value: string) => [{ type: "text" as const, text: value }];

function outcome(run: Run): string {
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "failed") {
    const how =
      run.exitCode !== undefined
        ? `with exit code ${run.exitCode}`
        : (run.error ?? (run.signal ? `on ${run.signal}` : ""));
    return `failed ${how}`.trim();
  }
  if (run.status === "interrupted") return "was interrupted because the pi-spore server stopped";
  return run.status;
}

/** Starts an action, waits for it to end, and returns its outcome with the log tail. */
async function runAction(
  client: BridgeClient,
  name: string,
  receipt: string,
  signal: AbortSignal | undefined,
  onUpdate: ((message: string) => void) | undefined,
): Promise<{ run: Run; report: string }> {
  let { run } = await client.call(RunAnswer, "runs", {
    body: { action: name },
    receipt,
    ...(signal ? { signal } : {}),
  });
  onUpdate?.(`${name}: ${run.status}`);
  try {
    while (!ENDED.has(run.status)) {
      ({ run } = await client.call(RunAnswer, `runs/${run.id}?wait=${WAIT_MS}`, {
        ...(signal ? { signal } : {}),
      }));
      onUpdate?.(`${name}: ${run.status}`);
    }
  } catch (error) {
    if (signal?.aborted) {
      // The model stopped waiting; the run must not go on without anyone reading it.
      await client.call(RunAnswer, `runs/${run.id}/cancel`, { body: {} }).catch(() => undefined);
    }
    throw error;
  }
  const log = await client.call(LogAnswer, `runs/${run.id}/log`);
  const tail = log.text.trimEnd();
  const report = [
    `Action "${name}" ${outcome(run)} (run ${run.id}).`,
    tail ? `${log.truncated ? "Last part of the log" : "Log"}:\n${tail}` : "The log is empty.",
  ].join("\n");
  return { run, report };
}

export default function sporeBridge(pi: ExtensionAPI) {
  let env: BridgeEnv;
  try {
    env = bridgeEnv(process.env);
  } catch (error) {
    const message = (error as Error).message;
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(`${message}. Its tools are off.`, "warning");
    });
    return;
  }
  const client = new BridgeClient(env);

  // ADR 0031: pi-spore's rules replace the user's global AGENTS.md in agents.
  pi.on("before_agent_start", (event) => {
    applyRules(event.systemPromptOptions, getAgentDir(), env.chatKind);
  });

  pi.registerTool({
    name: "request_human_input",
    label: "Ask the user",
    description:
      "File a question for the user on pi-spore's Home page and end your turn. The user answers when they can, " +
      "maybe hours later or after a restart; the answer arrives as a new user message. Write the question so you " +
      "can continue from the answer alone. Give choices when there are a few clear options; the user may still " +
      "answer in their own words.",
    promptSnippet:
      "Ask the user a question that waits on Home; the answer arrives later as a message",
    promptGuidelines: [
      "Use request_human_input when you need a decision or information only the user has. Call it alone, as the last tool call of your turn, then stop.",
      "If an ask_user tool is also available, use ask_user only for a quick choice while the user is watching the chat; it blocks and is lost if the process stops. Prefer request_human_input otherwise.",
    ],
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        maxLength: 4_000,
        description: "The question, with the context needed to answer it",
      }),
      choices: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
          minItems: 2,
          maxItems: 8,
          description: "Short answer options, if there are a few clear ones",
        }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      const { question } = await client.call(QuestionAnswer, "questions", {
        body: {
          question: params.question,
          ...(params.choices ? { choices: params.choices } : {}),
        },
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: text(
          `The question is on the user's Home page (question ${question.id}). Stop now. ` +
            "The answer arrives as a new user message.",
        ),
        details: { questionId: question.id },
        terminate: true,
      };
    },
  });

  // ADR 0033: side chats get only request_human_input (the launch allowlist), so these stay off there too.
  registerCardTools(pi, client);

  pi.registerTool({
    name: "check",
    label: "Check",
    description:
      "Run the project's check action (type checks, lint, compile) in this workspace and return its result and " +
      "the end of its log.",
    promptSnippet: "Run the project's checks and get their errors",
    promptGuidelines: [
      "Run check after you change code and before you say the work is done. Fix what it reports and run check again.",
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, onUpdate) {
      const { run, report } = await runAction(client, "check", toolCallId, signal, (message) =>
        onUpdate?.({ content: text(message), details: undefined }),
      );
      return { content: text(report), details: { runId: run.id, status: run.status } };
    },
  });

  pi.registerTool({
    name: "run_action",
    label: "Run action",
    description:
      "Run a named action from the project's .pi-spore/config.toml (for example test) in this workspace, wait " +
      "for it to end, and return its result and the end of its log.",
    promptSnippet: "Run a named project action such as test",
    promptGuidelines: [
      "Use run_action for the project's named commands (such as test) instead of guessing the command line.",
    ],
    parameters: Type.Object({
      name: Type.String({
        pattern: "^[a-z0-9_-]{1,64}$",
        description: "The action name, such as test",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      const { run, report } = await runAction(client, params.name, toolCallId, signal, (message) =>
        onUpdate?.({ content: text(message), details: undefined }),
      );
      return { content: text(report), details: { runId: run.id, status: run.status } };
    },
  });
}
