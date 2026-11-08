// A stand-in for `pi --mode rpc` in tests. It speaks the same JSONL protocol for the commands pi-spore uses, writes
// a session file in Pi's format, and answers prompts by echoing them. Special prompts:
//   "/dialog"      opens a confirm dialog and replies with the answer
//   "slow:<ms>"    streams the reply over <ms> milliseconds (for busy, steer, and abort)
//   "crash"        exits with code 3 after writing to stderr
//   "ask:<text>"   files <text> as a question through the bridge, as spore-bridge's request_human_input does, and
//                  ends the turn; the reply says the question id or the server's refusal
//   "tools"        replies with the tool allowlist it got (`--tools`), or Pi's default tools
//   "screenshot"   calls a `screenshot` tool whose result has an image block (FAKE_PNG in png.mjs)
//   "helper:<id>:<agent>:<state>"  sets the `subagent-async` widget as pi-subagents does in RPC mode, with one run
//                  <id> that has one step on <agent>. The model is `fake/helper-model`. Several ids add up. A run with
//                  state "gone" leaves the snapshot. Send it as a prompt, or as one while streaming (it is a command).
//   "helper-clear" clears the widget, as pi-subagents does about 10 s after the last run ends
//   "helper-bad"   sets the widget to a payload of an unknown version
//   "/subagents-inspect-rpc <request> <run> [child] --lines N"  answers with a `subagent-inspect` widget for a known
//                  run, or a not_found error reply, then clears the widget; runs as a command, even while streaming
// Images given with a prompt go into the user message after its text, as Pi does; the reply counts them. A queued
// message with images shows as "<text> [<n> images]" in queue_update.
// `--fork <file>` copies that session into a new one in `--session-dir`, with `parentSession` in the header, and
// refuses to be combined with `--session`, as Pi does.
// Environment: FAKE_PI_HANG=1 never answers; FAKE_PI_RECORD=<file> appends {argv, env, cwd, pid} for assertions;
// FAKE_PI_MODELS=broken answers get_available_models with a payload that is not a model list.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_PNG } from "./png.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
if (process.env.FAKE_PI_RECORD) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PI_SPORE_|ORCA_|HERDR_)/.test(key)),
  );
  appendFileSync(
    process.env.FAKE_PI_RECORD,
    `${JSON.stringify({ argv, env, cwd: process.cwd(), pid: process.pid })}\n`,
  );
}

/** Parses JSON or reports where it was bad, so a broken test input fails with a readable message. */
const parseJson = (text, where) => {
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: `fake-pi: invalid JSON in ${where}: ${text.slice(0, 120)}` };
  }
};

let sessionFile = arg("--session");
let lastEntryId = null;
let entryCount = 0;
const forkSource = arg("--fork");
if (forkSource && sessionFile) {
  process.stderr.write("Error: --fork cannot be combined with --session\n");
  process.exit(1);
}
if (forkSource) {
  const dir = arg("--session-dir");
  mkdirSync(dir, { recursive: true });
  const copied = readFileSync(forkSource, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((line) => parseJson(line, forkSource).type !== "session");
  sessionFile = join(dir, `${Date.now()}_fork.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: "f",
    cwd: process.cwd(),
    parentSession: forkSource,
  };
  writeFileSync(sessionFile, `${[JSON.stringify(header), ...copied].join("\n")}\n`);
  lastEntryId = copied.length > 0 ? parseJson(copied.at(-1), forkSource).id : null;
  entryCount = copied.length + 1;
} else if (sessionFile) {
  const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const last = parseJson(lines.at(-1) ?? "", sessionFile);
  if (last.parseError) {
    process.stderr.write(`${last.parseError}\n`);
    process.exit(2);
  }
  lastEntryId = last.id ?? null;
  entryCount = lines.length;
} else if (!argv.includes("--no-session")) {
  const dir = arg("--session-dir");
  mkdirSync(dir, { recursive: true });
  sessionFile = join(dir, `${Date.now()}_fake.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "s", cwd: process.cwd() })}\n`,
  );
}

const appendEntry = (entry) => {
  const id = `e${++entryCount}`;
  appendFileSync(sessionFile, `${JSON.stringify({ ...entry, id, parentId: lastEntryId })}\n`);
  lastEntryId = id;
};
const appendMessage = (message) => appendEntry({ type: "message", message });

let model = {
  provider: arg("--provider") ?? "fake",
  id: arg("--model") ?? "fake-1",
  name: "Fake",
  contextWindow: 100000,
  reasoning: true,
  input: ["text", "image"],
};
let thinkingLevel = arg("--thinking") ?? "medium";
let streaming = false;
let abortRun = null;
// Real time, like Pi: a resumed session must not reuse the first process's message timestamps.
let clock = Date.now();
const dialogs = new Map();

const helpers = new Map();
const INSPECT_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";

const writeWidget = (widgetKey, widgetLines) =>
  write({
    type: "extension_ui_request",
    id: `w${Date.now()}${Math.random()}`,
    method: "setWidget",
    widgetKey,
    ...(widgetLines === undefined ? {} : { widgetLines }),
  });

/** The snapshot pi-subagents sends: runs with steps as children (spike Q5). */
function publishHelpers() {
  const runs = [...helpers].map(([id, helper]) => ({
    id,
    kind: "subagent",
    label: helper.agent,
    state: helper.state,
    startedAt: 1000,
    updatedAt: Date.now(),
    activity: { lastActivityAt: Date.now() },
    children: [
      {
        id: "step:0",
        kind: "step",
        label: helper.agent,
        state: helper.state,
        agent: helper.agent,
        model: "fake/helper-model",
        thinking: "low",
      },
    ],
  }));
  const snapshot = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: Date.now(),
    runs,
  };
  writeWidget("subagent-async", [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`]);
}

function inspect(command) {
  const [requestId, runId, child] = command
    .slice("/subagents-inspect-rpc ".length)
    .split(" --lines")[0]
    .split(" ");
  const helper = helpers.get(runId);
  const reply = helper
    ? {
        kind: "pi-subagents.inspect-reply",
        version: 1,
        requestId,
        asyncId: runId,
        ...(child ? { childId: child } : {}),
        status: helper.state,
        label: helper.agent,
        task: `task of ${runId}`,
        messages: [{ role: "assistant", kind: "text", text: `${helper.agent} says hello` }],
        finalOutput: "all done",
        resolvedModel: { provider: "fake", model: "helper-model" },
      }
    : {
        kind: "pi-subagents.inspect-reply",
        version: 1,
        requestId,
        error: { code: "not_found", message: `No run ${runId}` },
      };
  writeWidget("subagent-inspect", [`${INSPECT_PREFIX}${JSON.stringify(reply)}`]);
  writeWidget("subagent-inspect");
}

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (id, command, data) =>
  write({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
const fail = (id, command, error) =>
  write({ id, type: "response", command, success: false, error });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pi's ImageContent check: refuses what Pi would refuse. */
const badImages = (images) =>
  images !== undefined &&
  (!Array.isArray(images) ||
    images.some(
      (image) =>
        image?.type !== "image" ||
        typeof image.data !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
        typeof image.mimeType !== "string",
    ));

async function screenshot() {
  const timestamp = ++clock;
  const call = { type: "toolCall", id: "call-shot", name: "screenshot", arguments: {} };
  const assistant = {
    role: "assistant",
    content: [call],
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp,
  };
  write({ type: "message_start", message: assistant });
  write({ type: "message_end", message: assistant });
  appendMessage(assistant);
  write({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: {} });
  const content = [
    { type: "text", text: "Captured" },
    { type: "image", data: FAKE_PNG, mimeType: "image/png" },
  ];
  write({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result: { content },
    isError: false,
  });
  const result = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: false,
    timestamp: ++clock,
  };
  write({ type: "message_start", message: result });
  write({ type: "message_end", message: result });
  appendMessage(result);
}

/** What spore-bridge's request_human_input sends: the agent token, and the tool call id as the receipt. */
async function ask(question, toolCallId) {
  try {
    const response = await fetch(`${process.env.PI_SPORE_URL}/api/bridge/questions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.PI_SPORE_TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": toolCallId,
      },
      body: JSON.stringify({ question }),
    });
    const body = await response.json();
    return response.ok
      ? `asked: ${body.question.id}`
      : `ask failed: ${response.status} ${body.error?.code}`;
  } catch (error) {
    return `ask failed: ${error.message}`;
  }
}

async function run(text, images = []) {
  streaming = true;
  let aborted = false;
  abortRun = () => {
    aborted = true;
  };
  write({ type: "agent_start" });
  const user = {
    role: "user",
    content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
    timestamp: ++clock,
  };
  write({ type: "message_start", message: user });
  write({ type: "message_end", message: user });
  appendMessage(user);

  let reply = images.length > 0 ? `echo: ${text} [${images.length} images]` : `echo: ${text}`;
  if (text === "screenshot") {
    await screenshot();
    reply = "Here is the screenshot.";
  }
  if (text === "tools") reply = `tools: ${arg("--tools") ?? "read,bash,edit,write"}`;
  if (text.startsWith("ask:")) reply = await ask(text.slice(4), `toolu_${entryCount}`);
  if (text === "/dialog") {
    const answer = await new Promise((resolve) => {
      dialogs.set("dlg-1", resolve);
      write({
        type: "extension_ui_request",
        id: "dlg-1",
        method: "confirm",
        title: "Proceed?",
        message: "Fake dialog",
      });
    });
    reply = `confirmed: ${answer.confirmed === true}`;
  }
  const total = text.startsWith("slow:") ? Number(text.slice(5)) : 0;
  const timestamp = ++clock;
  write({
    type: "message_start",
    message: { role: "assistant", content: [], stopReason: "pending", timestamp },
  });
  write({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  const parts = [reply.slice(0, 3), reply.slice(3)];
  for (const part of parts) {
    if (total > 0) await sleep(total / parts.length);
    if (aborted) break;
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part },
    });
  }
  const final = {
    role: "assistant",
    content: [{ type: "text", text: aborted ? reply.slice(0, 3) : reply }],
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : "stop",
    timestamp,
  };
  write({ type: "message_end", message: final });
  appendMessage(final);
  streaming = false;
  abortRun = null;
  write({ type: "agent_end", messages: [] });
  write({ type: "agent_settled", aborted });
}

const handle = (command) => {
  const { id, type } = command;
  switch (type) {
    case "get_state":
      return respond(id, type, {
        model,
        thinkingLevel,
        isStreaming: streaming,
        sessionFile,
        sessionId: "s",
        messageCount: entryCount,
      });
    case "prompt":
      if (command.message === "crash") {
        process.stderr.write("boom: the fake agent crashed\n");
        process.exit(3);
      }
      if (command.message.startsWith("/subagents-inspect-rpc ")) {
        inspect(command.message);
        return respond(id, type, { disposition: "handled" });
      }
      if (command.message.startsWith("helper:")) {
        const [, runId, agent, state] = command.message.split(":");
        if (state === "gone") helpers.delete(runId);
        else helpers.set(runId, { agent, state });
        publishHelpers();
        return respond(id, type, { disposition: "handled" });
      }
      if (command.message === "helper-clear" || command.message === "helper-bad") {
        helpers.clear();
        if (command.message === "helper-clear") writeWidget("subagent-async");
        else writeWidget("subagent-async", ['PI_SUBAGENT_ASYNC_JSON:{"kind":"x","version":9}']);
        return respond(id, type, { disposition: "handled" });
      }
      if (badImages(command.images)) return fail(id, type, "images must be ImageContent blocks");
      if (streaming && !command.streamingBehavior)
        return fail(id, type, "Agent is streaming; set streamingBehavior");
      if (streaming) {
        const queued = command.images
          ? `${command.message} [${command.images.length} images]`
          : command.message;
        write({
          type: "queue_update",
          steering: command.streamingBehavior === "steer" ? [queued] : [],
          followUp: command.streamingBehavior === "followUp" ? [queued] : [],
        });
        return respond(id, type, { disposition: "queued" });
      }
      respond(id, type, { disposition: "started" });
      return void run(command.message, command.images);
    case "abort":
      abortRun?.();
      return setTimeout(() => respond(id, type), 5);
    case "set_model":
      model = { ...model, provider: command.provider, id: command.modelId, name: command.modelId };
      appendEntry({ type: "model_change", provider: command.provider, modelId: command.modelId });
      return respond(id, type, model);
    case "set_thinking_level":
      thinkingLevel = command.level;
      appendEntry({ type: "thinking_level_change", thinkingLevel: command.level });
      write({ type: "thinking_level_changed", level: command.level });
      return respond(id, type);
    case "get_available_models":
      if (process.env.FAKE_PI_MODELS === "broken") return respond(id, type, { models: "none" });
      return respond(id, type, {
        models: [
          model,
          {
            provider: "fake",
            id: "fake-2",
            name: "Fake 2",
            contextWindow: 50000,
            reasoning: false,
            input: ["text"],
          },
        ],
      });
    case "get_available_thinking_levels":
      return respond(id, type, { levels: ["off", "low", "medium", "high"] });
    case "get_session_stats":
      return respond(id, type, {
        sessionFile,
        contextUsage: { tokens: 1234, contextWindow: model.contextWindow, percent: 1.2 },
      });
    case "get_commands":
      return respond(id, type, {
        commands: [{ name: "review", description: "Review the diff", source: "prompt" }],
      });
    case "compact":
      return respond(id, type, { summary: "compacted" });
    case "extension_ui_response": {
      const resolve = dialogs.get(command.id);
      dialogs.delete(command.id);
      return resolve?.(command);
    }
    default:
      return fail(id, type, `fake-pi does not know ${type}`);
  }
};

if (process.env.FAKE_PI_HANG === "1") {
  // Stay alive without ever answering, like a Pi stuck at startup.
  setInterval(() => {}, 1_000);
} else {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const command = line.trim() ? parseJson(line, "stdin") : undefined;
      if (command?.parseError)
        write({ type: "response", success: false, error: command.parseError });
      else if (command) handle(command);
      newline = buffer.indexOf("\n");
    }
  });
}
process.stdin.on("end", () => process.exit(0));
