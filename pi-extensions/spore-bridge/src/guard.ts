/**
 * The bash guard: agents that work on pi-spore itself must not stop the pi-spore server that runs every chat.
 * It blocks a bash command that would kill the server and allows everything else. When in doubt it allows.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { BridgeEnv } from "./client.js";

export const STOP_REASON =
  "This would stop the pi-spore server that runs this chat. Start a test server with run_action dev and stop it with stop_action.";

/** What the guard knows of the server process. Only pid and port when `ps` could not be read. */
export interface ServerFacts {
  pid: number;
  pgid?: number;
  port: number;
  comm?: string;
  args?: string;
}

interface SimpleCommand {
  words: string[];
  /** The text inside each `$(...)` or backtick quote in the words. */
  substitutions: string[];
  /** The pipeline before this command, when its input is a pipe. */
  pipedFrom?: string;
}

/** The index of the `)` that closes a `(` opened just before `from`, skipping quoted text. */
function closing(source: string, from: number): number {
  let depth = 1;
  let quote: string | undefined;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === "\\" && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return source.length;
}

/** Splits a bash command line into its simple commands, nested ones included. Quoted text stays inside its word. */
function simpleCommands(source: string): SimpleCommand[] {
  const found: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], substitutions: [] };
  let word: string | undefined;
  let doubleQuoted = false;
  let redirectTarget = false;
  let pipelineStart = 0;
  const add = (text: string) => {
    word = (word ?? "") + text;
  };
  const endWord = () => {
    if (word !== undefined && !redirectTarget) current.words.push(word);
    if (word !== undefined) redirectTarget = false;
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    redirectTarget = false;
    if (current.words.length > 0) found.push(current);
    current = { words: [], substitutions: [] };
  };
  const substitution = (text: string) => {
    current.substitutions.push(text);
    found.push(...simpleCommands(text));
    add("");
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    const next = source[i + 1] ?? "";
    if (c === "\\") {
      if (next !== "\n") add(doubleQuoted && !'"\\$`'.includes(next) ? c + next : next);
      i++;
    } else if (c === '"') {
      doubleQuoted = !doubleQuoted;
      add("");
    } else if (c === "$" && next === "(") {
      const end = closing(source, i + 2);
      substitution(source.slice(i + 2, end));
      i = end;
    } else if (c === "`") {
      const close = source.indexOf("`", i + 1);
      const end = close < 0 ? source.length : close;
      substitution(source.slice(i + 1, end));
      i = end;
    } else if (doubleQuoted) add(c);
    else if (c === "'") {
      const close = source.indexOf("'", i + 1);
      const end = close < 0 ? source.length : close;
      add(source.slice(i + 1, end));
      i = end;
    } else if (c === "#" && word === undefined) {
      const newline = source.indexOf("\n", i);
      i = (newline < 0 ? source.length : newline) - 1;
    } else if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      // `2>&1` and `> file`: the fd number and the target are not arguments.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      else endWord();
      while ("<>&|".includes(source[i + 1] ?? "x")) i++;
      redirectTarget = true;
    } else if (c === "|" && next !== "|") {
      const pipedFrom = source.slice(pipelineStart, i);
      endCommand();
      current.pipedFrom = pipedFrom;
      if (next === "&") i++;
    } else if (";&|()\n".includes(c)) {
      endCommand();
      if (c === "|") i++;
      pipelineStart = i + 1;
    } else if (/\s/.test(c)) endWord();
    else add(c);
  }
  endCommand();
  return found;
}

/** Commands that run the command after them, with their options that take a value. */
const WRAPPERS = new Map<string, string[]>([
  ["sudo", ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]],
  ["env", ["-u", "-C", "-S"]],
  ["nohup", []],
  ["command", []],
  ["builtin", []],
  ["exec", ["-a"]],
  ["nice", ["-n"]],
  ["time", []],
  ["timeout", ["-s", "-k"]],
  ["xargs", ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]],
]);
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);

/** The command a simple command runs, past wrappers, keywords, and `VAR=x` assignments. */
function invocation(
  words: string[],
): { name: string; args: string[]; viaXargs: boolean } | undefined {
  let viaXargs = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word)) continue;
    const name = word.slice(word.lastIndexOf("/") + 1);
    const valued = WRAPPERS.get(name);
    if (!valued) return { name, args: words.slice(i + 1), viaXargs };
    viaXargs ||= name === "xargs";
    while (words[i + 1]?.startsWith("-")) {
      i++;
      if (valued.includes(words[i] as string)) i++;
    }
    if (name === "timeout") i++; // its duration
  }
  return undefined;
}

const MARKERS = ["dist/main.js", "pi-spore", "packages/server"];
const PID_VARIABLE = /^\$\{?PI_SPORE_SERVER_PID\}?$/;
const hasMarker = (text: string) => MARKERS.some((marker) => text.includes(marker));
const namesPort = (text: string, port: number) => new RegExp(`(?<!\\d)${port}(?!\\d)`).test(text);
/** Whether text that produces pids (a `$(...)` or the start of a pipe) looks for the server. */
const findsServer = (text: string, server: ServerFacts) =>
  namesPort(text, server.port) || text.includes("PI_SPORE_SERVER_PID") || hasMarker(text);

function matches(pattern: string, text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

/** Splits arguments into options and the rest; `valued` options take the next argument. */
function split(args: string[], valued: string[]): { flags: string[]; operands: string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      flags.push(arg);
      if (valued.includes(arg)) i++;
    } else operands.push(arg);
  }
  return { flags, operands };
}

function killStops(
  args: string[],
  command: SimpleCommand,
  viaXargs: boolean,
  server: ServerFacts,
): boolean {
  const targets: string[] = [];
  let signal: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      targets.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-l" || arg === "-L") return false;
    if (arg === "-s" || arg === "-n" || arg === "--signal") signal = args[++i];
    // The first `-X` is the signal; after it, `-N` is a process group.
    else if (signal === undefined && arg.startsWith("-")) signal = arg.slice(1);
    else targets.push(arg);
  }
  // Signal 0 only checks that the process is alive.
  if (signal?.replace(/^SIG/i, "") === "0") return false;
  return (
    targets.some(
      (target) =>
        target === String(server.pid) ||
        target === "-1" ||
        (server.pgid !== undefined && target === `-${server.pgid}`) ||
        PID_VARIABLE.test(target),
    ) ||
    command.substitutions.some((text) => findsServer(text, server)) ||
    (viaXargs && command.pipedFrom !== undefined && findsServer(command.pipedFrom, server))
  );
}

/** Whether a bash command line would stop the pi-spore server. */
export function stopsServer(command: string, server: ServerFacts): boolean {
  return simpleCommands(command).some((simple) => {
    const call = invocation(simple.words);
    if (!call) return false;
    if (call.name === "kill") return killStops(call.args, simple, call.viaXargs, server);
    if (call.name === "pkill") {
      const { flags, operands } = split(call.args, [
        "-g",
        "-G",
        "-P",
        "-s",
        "-t",
        "-u",
        "-U",
        "-F",
        "--signal",
        "--pidfile",
        "--ns",
        "--nslist",
      ]);
      const full = flags.some((flag) => flag === "--full" || /^-[a-z]*f/.test(flag));
      return operands.some(
        (pattern) =>
          hasMarker(pattern) ||
          pattern === "node" ||
          matches(pattern, full ? server.args : server.comm),
      );
    }
    if (call.name === "killall") {
      const { flags, operands } = split(call.args, [
        "-s",
        "--signal",
        "-u",
        "--user",
        "-o",
        "--older-than",
        "-y",
        "--younger-than",
        "-Z",
        "--context",
      ]);
      const regex = flags.some((flag) => flag === "--regexp" || /^-[a-z]*r/.test(flag));
      return operands.some(
        (name) =>
          hasMarker(name) ||
          name === "node" ||
          (regex ? matches(name, server.comm) : name === server.comm),
      );
    }
    if (call.name === "fuser")
      return (
        call.args.some((arg) => arg === "--kill" || /^-[a-z]*k/.test(arg)) &&
        call.args.some(
          (arg) => !arg.startsWith("-") && (namesPort(arg, server.port) || hasMarker(arg)),
        )
      );
    return false;
  });
}

const execFileAsync = promisify(execFile);

/** Reads the server's process group, name, and command line with `ps`. */
async function readServerFacts(pid: number, port: number): Promise<ServerFacts> {
  const { stdout } = await execFileAsync("ps", ["-o", "pgid=,comm=,args=", "-p", String(pid)]);
  const line = /^([1-9]\d*)\s+(\S+)\s+(.+)$/.exec(stdout.trim());
  if (!line) throw new Error(`ps gave no process line for pid ${pid}: "${stdout.trim()}"`);
  return { pid, port, pgid: Number(line[1]), comm: line[2] as string, args: line[3] as string };
}

/** Blocks bash commands that would stop the server. Reads the server facts once, on the first bash call. */
export function registerServerGuard(pi: ExtensionAPI, env: BridgeEnv): void {
  const port = Number(new URL(env.url).port || 80);
  let facts: Promise<ServerFacts> | undefined;
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    facts ??= readServerFacts(env.serverPid, port).catch((error: Error) => {
      // Never block because ps failed: the pid and port still guard the common cases.
      if (ctx.hasUI)
        ctx.ui.notify(
          `spore-bridge could not read the pi-spore server process (${error.message}). ` +
            `The bash guard checks only pid ${env.serverPid} and port ${port}.`,
          "warning",
        );
      return { pid: env.serverPid, port };
    });
    if (stopsServer(event.input.command, await facts)) return { block: true, reason: STOP_REASON };
  });
}
