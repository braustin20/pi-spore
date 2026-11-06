// Spike Q1 driver: starts `pi --mode rpc` the way pi-spore will and measures what it loads and how much memory it
// uses. Usage: node spikes/q1-rpc/drive.mjs <out dir> <work dir> <long session file>
// Raw results can hold home paths, so they go to <out dir>, never into the repo.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [outDir, workDir, longSession] = process.argv.slice(2);
if (!outDir || !workDir || !longSession) {
  throw new Error("Usage: node drive.mjs <out dir> <work dir> <long session file>");
}
mkdirSync(outDir, { recursive: true });
const probe = new URL("./probe.ts", import.meta.url).pathname;

// Agents must not inherit the host terminal's Orca or herdr identity.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(ORCA|HERDR)_/.test(key)),
);

/** Parses JSON and names the source in the error, so a bad record stops the spike with a readable message. */
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${what}: ${text.slice(0, 200)}`, { cause: error });
  }
}

/** PSS and RSS of a process and all its descendants, from /proc. PSS splits shared pages fairly. */
function treeMemory(rootPid) {
  const parents = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(name), Number(fields[1]));
    } catch {
      // The process exited while we scanned.
    }
  }
  const pids = [rootPid];
  for (let i = 0; i < pids.length; i++) {
    for (const [pid, ppid] of parents) if (ppid === pids[i]) pids.push(pid);
  }
  const procs = [];
  for (const pid of pids) {
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(rollup)?.[1] ?? 0);
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      procs.push({ pid, comm, rssMB: kb("Rss") / 1024, pssMB: kb("Pss") / 1024 });
    } catch {
      // Exited, or not readable.
    }
  }
  const sum = (key) => Math.round(procs.reduce((total, proc) => total + proc[key], 0));
  return { pssMB: sum("pssMB"), rssMB: sum("rssMB"), procs };
}

class Agent {
  constructor(name, args) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.uiRequests = [];
    this.settledWaiters = [];
    this.child = spawn("pi", ["--mode", "rpc", ...args], {
      cwd: workDir,
      env: { ...childEnv, SPORE_PROBE_OUT: join(outDir, `${name}-probe.json`) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    // Split records on LF only: readline would also split on U+2028/U+2029 inside JSON strings.
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) this.onRecord(parseJson(line, `${this.name} stdout record`));
        newline = buffer.indexOf("\n");
      }
    });
  }

  onRecord(record) {
    if (record.type === "response" && this.pending.has(record.id)) {
      this.pending.get(record.id)(record);
      this.pending.delete(record.id);
      return;
    }
    if (record.type === "extension_ui_request") {
      this.uiRequests.push({ method: record.method, title: record.title });
      const reply = { type: "extension_ui_response", id: record.id };
      if (record.method === "confirm") this.send({ ...reply, confirmed: true });
      else if (record.method === "select") this.send({ ...reply, value: record.options?.[0] });
      else if (record.method === "input" || record.method === "editor")
        this.send({ ...reply, value: "" });
      return;
    }
    this.events.push(record.type);
    if (record.type === "agent_settled")
      for (const resolve of this.settledWaiters.splice(0)) resolve();
  }

  send(record) {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  command(type, fields = {}, timeoutMs = 120_000) {
    const id = `c${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.name}: ${type} timed out`)),
        timeoutMs,
      );
      this.pending.set(id, (record) => {
        clearTimeout(timer);
        if (record.success === false)
          reject(new Error(`${this.name}: ${type} failed: ${record.error}`));
        else resolve(record.data);
      });
      this.send({ id, type, ...fields });
    });
  }

  settled(timeoutMs) {
    return Promise.race([
      new Promise((resolve) => this.settledWaiters.push(resolve)),
      sleep(timeoutMs).then(() => {
        throw new Error(`${this.name}: run did not settle in ${timeoutMs} ms`);
      }),
    ]);
  }

  /** Samples memory until `done` resolves; returns the peak sample. */
  async peakWhile(done) {
    let peak = treeMemory(this.child.pid);
    let finished = false;
    const result = done.finally(() => {
      finished = true;
    });
    while (!finished) {
      await Promise.race([sleep(250), result.catch(() => {})]);
      const sample = treeMemory(this.child.pid);
      if (sample.pssMB > peak.pssMB) peak = sample;
    }
    await result;
    return peak;
  }

  async stop() {
    this.child.stdin.end();
    await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), sleep(10_000)]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

const summary = (memory) => ({
  pssMB: memory.pssMB,
  rssMB: memory.rssMB,
  procs: memory.procs.map((proc) => `${proc.comm}:${Math.round(proc.pssMB)}`),
});
const results = {};

// A. Load: a fresh agent with the user's full setup plus the probe.
{
  const agent = new Agent("load", ["--no-session", "-e", probe]);
  const started = Date.now();
  const state = await agent.command("get_state");
  results.load = {
    readyMs: Date.now() - started,
    model: `${state.model?.provider}/${state.model?.id}`,
  };
  results.load.memoryAtReady = summary(treeMemory(agent.child.pid));
  const { commands } = await agent.command("get_commands");
  results.load.commandSources = commands.reduce((counts, command) => {
    counts[command.source] = (counts[command.source] ?? 0) + 1;
    return counts;
  }, {});
  await agent.command("prompt", { message: "/spore-probe" });
  const probeFile = join(outDir, "load-probe.json");
  for (let i = 0; i < 100 && !existsSync(probeFile); i++) await sleep(100);
  if (!existsSync(probeFile))
    throw new Error(`Probe did not write ${probeFile}. Stderr:\n${agent.stderr}`);
  results.load.probe = parseJson(readFileSync(probeFile, "utf8"), "probe output");
  results.load.uiRequests = agent.uiRequests;
  await sleep(15_000);
  results.load.memorySettled = summary(treeMemory(agent.child.pid));

  // B. Busy: a short real task with tool calls, on a cheap model at low thinking.
  await agent.command("set_model", { provider: "claude-bridge", modelId: "claude-haiku-5-5" });
  await agent.command("set_thinking_level", { level: "low" });
  const settled = agent.settled(300_000);
  await agent.command("prompt", {
    message:
      "Do not edit any files. Run `git log --oneline`, read package.json and docs/architecture.md, " +
      "list the files under packages/, then reply with a three-line summary of this repository.",
  });
  const busyStarted = Date.now();
  const peak = await agent.peakWhile(settled);
  results.busy = { runMs: Date.now() - busyStarted, peak: summary(peak) };
  results.busy.answer = (await agent.command("get_last_assistant_text"))?.text?.slice(0, 400);
  results.busy.stats = await agent.command("get_session_stats");
  await sleep(20_000);
  results.busy.memoryAfter20s = summary(treeMemory(agent.child.pid));
  results.load.stderrTail = agent.stderr.slice(-2000);
  await agent.stop();
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
}

// C. Long session: open a copy of a large session file. Never the original.
{
  // Pi waits forever in RPC mode when a session's stored cwd is gone, so the copy points at the work dir.
  const copy = join(outDir, basename(longSession));
  copyFileSync(longSession, copy);
  const lines = readFileSync(copy, "utf8").split("\n");
  const header = parseJson(lines[0] ?? "", "session header");
  lines[0] = JSON.stringify({ ...header, cwd: workDir });
  writeFileSync(copy, lines.join("\n"));
  const agent = new Agent("long", ["--session", copy]);
  const started = Date.now();
  const state = await agent.command("get_state", {}, 300_000).catch((error) => {
    throw new Error(`${error.message}. Stderr:\n${agent.stderr}`);
  });
  results.long = {
    fileMB: Math.round(readFileSync(copy).length / 1024 / 1024),
    readyMs: Date.now() - started,
    messageCount: state.messageCount,
    memoryAtReady: summary(treeMemory(agent.child.pid)),
  };
  await sleep(15_000);
  results.long.memorySettled = summary(treeMemory(agent.child.pid));
  await agent.stop();
}

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
