// A stand-in for `pi --mode rpc` in tests. It speaks the same JSONL protocol for the commands pi-spore uses, writes
// a session file in Pi's format, and answers prompts by echoing them. Special prompts:
//   "/dialog"      opens a confirm dialog and replies with the answer
//   "slow:<ms>"    streams the reply over <ms> milliseconds (for busy, steer, and abort)
//   "crash"        exits with code 3 after writing to stderr
// Environment: FAKE_PI_HANG=1 never answers; FAKE_PI_RECORD=<file> appends {argv, env} for assertions.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    `${JSON.stringify({ argv, env, cwd: process.cwd() })}\n`,
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
if (sessionFile) {
  const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const last = parseJson(lines.at(-1) ?? "", sessionFile);
  if (last.parseError) {
    process.stderr.write(`${last.parseError}\n`);
    process.exit(2);
  }
  lastEntryId = last.id ?? null;
  entryCount = lines.length;
} else {
  const dir = arg("--session-dir");
  mkdirSync(dir, { recursive: true });
  sessionFile = join(dir, `${Date.now()}_fake.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "s", cwd: process.cwd() })}\n`,
  );
}

const appendMessage = (message) => {
  const id = `e${++entryCount}`;
  appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: "message", id, parentId: lastEntryId, message })}\n`,
  );
  lastEntryId = id;
};

let model = {
  provider: arg("--provider") ?? "fake",
  id: arg("--model") ?? "fake-1",
  name: "Fake",
  contextWindow: 100000,
  reasoning: true,
};
let thinkingLevel = arg("--thinking") ?? "medium";
let streaming = false;
let abortRun = null;
// Real time, like Pi: a resumed session must not reuse the first process's message timestamps.
let clock = Date.now();
const dialogs = new Map();

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (id, command, data) =>
  write({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
const fail = (id, command, error) =>
  write({ id, type: "response", command, success: false, error });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(text) {
  streaming = true;
  let aborted = false;
  abortRun = () => {
    aborted = true;
  };
  write({ type: "agent_start" });
  const user = { role: "user", content: text, timestamp: ++clock };
  write({ type: "message_start", message: user });
  write({ type: "message_end", message: user });
  appendMessage(user);

  let reply = `echo: ${text}`;
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
      if (streaming && !command.streamingBehavior)
        return fail(id, type, "Agent is streaming; set streamingBehavior");
      if (streaming) {
        write({
          type: "queue_update",
          steering: command.streamingBehavior === "steer" ? [command.message] : [],
          followUp: command.streamingBehavior === "followUp" ? [command.message] : [],
        });
        return respond(id, type, { disposition: "queued" });
      }
      respond(id, type, { disposition: "started" });
      return void run(command.message);
    case "abort":
      abortRun?.();
      return setTimeout(() => respond(id, type), 5);
    case "set_model":
      model = { ...model, provider: command.provider, id: command.modelId, name: command.modelId };
      return respond(id, type, model);
    case "set_thinking_level":
      thinkingLevel = command.level;
      write({ type: "thinking_level_changed", level: command.level });
      return respond(id, type);
    case "get_available_models":
      return respond(id, type, {
        models: [
          model,
          {
            provider: "fake",
            id: "fake-2",
            name: "Fake 2",
            contextWindow: 50000,
            reasoning: false,
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
