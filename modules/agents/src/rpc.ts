import { type ChildProcess, spawn } from "node:child_process";
import type { AgentDialog } from "@pi-spore/shared";

/** How to start Pi: `{ command: "pi", args: [] }` for real, a fake in tests. `--mode rpc` is added after `args`. */
export interface PiCommand {
  command: string;
  args: readonly string[];
}

export interface PiProcessOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Launch arguments after `--mode rpc`. */
  args: readonly string[];
  onEvent(event: Record<string, unknown>): void;
  onDialog(dialog: AgentDialog, timeoutMs: number | undefined): void;
  onNotice(level: string, message: string): void;
  onExit(code: number | null, signal: string | null): void;
}

export class PiRequestError extends Error {
  override name = "PiRequestError";
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STDERR_TAIL = 4_000;

interface Pending {
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** One `pi --mode rpc` child process and its JSONL protocol (Pi docs: rpc.md, rpc-extension-ui.md). */
export class PiProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private stderr = "";
  private exited = false;

  constructor(
    base: PiCommand,
    private readonly options: PiProcessOptions,
  ) {
    this.child = spawn(base.command, [...base.args, "--mode", "rpc", ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    this.child.stdout?.setEncoding("utf8");
    // Split on LF only: readline also splits on U+2028 and U+2029, which are valid inside JSON strings.
    let buffer = "";
    this.child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) this.onLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    this.child.stdin?.on("error", () => {
      // EPIPE after the child died; the exit handler reports it.
    });
    this.child.on("error", (error) => {
      this.stderr = `${this.stderr}\n${error.message}`.slice(-STDERR_TAIL);
      this.finish(null, null);
    });
    // "close" comes after stdout and stderr have ended; "exit" can come first and lose the last of Pi's stderr.
    this.child.on("close", (code, signal) => this.finish(code, signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.exited;
  }

  stderrTail(): string {
    return this.stderr.trim();
  }

  /** Sends a command and resolves with its `data`. Rejects on `success: false`, on timeout, and if Pi exits. */
  request<T = unknown>(
    type: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<T> {
    if (this.exited) return Promise.reject(new PiRequestError(`Pi exited before "${type}"`));
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRequestError(`Pi did not answer "${type}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      this.write({ id, type, ...fields });
    });
  }

  answerDialog(answer: {
    dialogId: string;
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }): void {
    const { dialogId, ...rest } = answer;
    this.write({ type: "extension_ui_response", id: dialogId, ...rest });
  }

  /** Closes stdin, which ends Pi; escalates to SIGTERM and SIGKILL if it does not exit in time. */
  async stop(graceMs = 5_000): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.child.stdin?.end();
    const wait = (ms: number) =>
      Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    if (await wait(graceMs)) return;
    this.child.kill("SIGTERM");
    if (await wait(2_000)) return;
    this.child.kill("SIGKILL");
    await exited;
  }

  private write(record: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(record)}\n`);
  }

  private onLine(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.stderr = `${this.stderr}\n[stdout, not JSON] ${line.slice(0, 200)}`.slice(-STDERR_TAIL);
      return;
    }
    if (
      record.type === "response" &&
      typeof record.id === "string" &&
      this.pending.has(record.id)
    ) {
      const pending = this.pending.get(record.id) as Pending;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success === false) {
        pending.reject(
          new PiRequestError(String(record.error ?? `Pi refused "${String(record.command)}"`)),
        );
      } else pending.resolve(record.data);
      return;
    }
    if (record.type === "extension_ui_request") this.onUiRequest(record);
    else this.options.onEvent(record);
  }

  private onUiRequest(record: Record<string, unknown>): void {
    const method = String(record.method);
    if (DIALOG_METHODS.has(method)) {
      const text = (key: string) =>
        typeof record[key] === "string" ? { [key]: record[key] as string } : {};
      const dialog: AgentDialog = {
        id: String(record.id),
        method: method as AgentDialog["method"],
        ...text("title"),
        ...text("message"),
        ...text("placeholder"),
        ...text("prefill"),
        ...(Array.isArray(record.options) ? { options: record.options.map(String) } : {}),
      };
      this.options.onDialog(
        dialog,
        typeof record.timeout === "number" ? record.timeout : undefined,
      );
    } else if (method === "notify" && typeof record.message === "string") {
      this.options.onNotice(String(record.notifyType ?? record.level ?? "info"), record.message);
    }
    // setStatus, setWidget, setTitle, and set_editor_text are terminal UI hints with no place in the web chat yet.
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new PiRequestError(`Pi exited (code ${code ?? signal}) before answering ${id}`),
      );
    }
    this.pending.clear();
    this.options.onExit(code, signal);
  }
}
