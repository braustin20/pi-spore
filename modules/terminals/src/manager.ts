import { ApiError, type ModuleSocket } from "@pi-spore/module-api";
import {
  parse,
  type Terminal,
  TerminalClientMessage,
  type TerminalServerMessage,
  type Workspace,
} from "@pi-spore/shared";
import { type IPty, spawn } from "node-pty";

/** The program a terminal runs. */
export interface ShellCommand {
  command: string;
  args: readonly string[];
}

export interface ManagerOptions {
  /** Resolved for each new terminal, so a missing `$SHELL` fails that request, not startup. */
  shell: () => ShellCommand;
  maxOpen: number;
  /** How much recent output a reconnect gets, in characters. */
  scrollbackChars: number;
  now: () => number;
  newId: () => string;
}

interface Live {
  view: Terminal;
  pty: IPty;
  scrollback: string;
  sockets: Set<ModuleSocket>;
  exited: Promise<void>;
}

/** How long a closed shell gets after SIGHUP before SIGKILL. */
const KILL_GRACE_MS = 5_000;

// A PTY's shell gets SIGHUP when the server's side of the PTY closes, but only if the server dies cleanly enough to
// close it. This sends it on every exit of the server process, as the actions module does for its runs.
const livePtys = new Set<IPty>();
let exitHookInstalled = false;
function track(pty: IPty): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const live of livePtys) hangUp(live, "SIGHUP");
    });
  }
  livePtys.add(pty);
}

function hangUp(pty: IPty, signal: NodeJS.Signals): void {
  try {
    pty.kill(signal);
  } catch (error) {
    // ESRCH: the shell is already gone.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** The last `max` characters of `text`, from the start of a line where it can, so a cut rarely splits a sequence. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = text.slice(text.length - max);
  const newline = kept.indexOf("\n");
  return newline === -1 ? kept : kept.slice(newline + 1);
}

function send(socket: ModuleSocket, message: TerminalServerMessage): void {
  socket.send(JSON.stringify(message));
}

/**
 * Terminals live in memory: a PTY cannot outlive the server, so a stored record would only point at a dead shell.
 * Terminal input and output never reach a log.
 */
export class TerminalManager {
  private readonly live = new Map<string, Live>();

  constructor(private readonly options: ManagerOptions) {}

  list(workspaceId: string): Terminal[] {
    return [...this.live.values()]
      .filter((entry) => entry.view.workspaceId === workspaceId)
      .map((entry) => ({ ...entry.view }));
  }

  get(id: string): Terminal {
    return { ...this.find(id).view };
  }

  open(
    workspace: Workspace,
    request: { title?: string; cols: number; rows: number },
    env: Record<string, string>,
  ): Terminal {
    if (this.live.size >= this.options.maxOpen) {
      throw new ApiError(
        409,
        "terminal_limit",
        `${this.options.maxOpen} terminals are open, the most allowed; close one first`,
      );
    }
    const shell = this.options.shell();
    const pty = spawn(shell.command, [...shell.args], {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: workspace.path,
      env,
    });
    track(pty);
    const view: Terminal = {
      id: this.options.newId(),
      workspaceId: workspace.id,
      title: request.title ?? this.nextTitle(workspace.id),
      shell: shell.command,
      cols: request.cols,
      rows: request.rows,
      status: "running",
      createdAt: this.options.now(),
    };
    let markExited: () => void = () => {};
    const entry: Live = {
      view,
      pty,
      scrollback: "",
      sockets: new Set(),
      exited: new Promise((resolve) => {
        markExited = resolve;
      }),
    };
    const max = this.options.scrollbackChars;
    pty.onData((data) => {
      // Trimmed in steps, not on every chunk, so a busy shell does not copy the whole buffer each time.
      entry.scrollback += data;
      if (entry.scrollback.length > max + max / 4) entry.scrollback = tail(entry.scrollback, max);
      for (const socket of entry.sockets) send(socket, { type: "output", data });
    });
    pty.onExit(({ exitCode, signal }) => {
      livePtys.delete(pty);
      view.status = "exited";
      view.exitCode = exitCode;
      if (signal) view.signal = signal;
      for (const socket of entry.sockets) send(socket, this.exitMessage(view));
      markExited();
    });
    this.live.set(view.id, entry);
    return { ...view };
  }

  /** Accepts a browser's socket: the scrollback first, then live output. Throws ApiError 404 for an unknown id. */
  connect(id: string): (socket: ModuleSocket) => void {
    const entry = this.find(id);
    return (socket) => {
      send(socket, {
        type: "snapshot",
        data: tail(entry.scrollback, this.options.scrollbackChars),
      });
      if (entry.view.status === "exited") send(socket, this.exitMessage(entry.view));
      entry.sockets.add(socket);
      socket.onClose(() => entry.sockets.delete(socket));
      socket.onMessage((text) => this.receive(entry, socket, text));
    };
  }

  /** Ends the shell and forgets the terminal. Resolves when the shell has exited. */
  async close(id: string): Promise<Terminal> {
    const entry = this.find(id);
    this.live.delete(id);
    if (entry.view.status === "running") {
      hangUp(entry.pty, "SIGHUP");
      const timer = setTimeout(() => hangUp(entry.pty, "SIGKILL"), KILL_GRACE_MS);
      await entry.exited;
      clearTimeout(timer);
    }
    for (const socket of entry.sockets) socket.close(1000, "Terminal closed");
    return { ...entry.view };
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(this.list(workspaceId).map((terminal) => this.close(terminal.id)));
  }

  private receive(entry: Live, socket: ModuleSocket, text: string): void {
    let message: TerminalClientMessage;
    try {
      message = parse(TerminalClientMessage, JSON.parse(text), "terminal message");
    } catch (error) {
      const reason =
        error instanceof SyntaxError ? "Terminal messages must be JSON" : String(error);
      send(socket, { type: "error", message: reason.replace(/^ValidationError: /, "") });
      return;
    }
    if (entry.view.status === "exited") {
      send(socket, { type: "error", message: "The shell has exited" });
      return;
    }
    if (message.type === "input") entry.pty.write(message.data);
    else {
      entry.pty.resize(message.cols, message.rows);
      entry.view.cols = message.cols;
      entry.view.rows = message.rows;
    }
  }

  private exitMessage(view: Terminal): TerminalServerMessage {
    return {
      type: "exit",
      ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}),
      ...(view.signal !== undefined ? { signal: view.signal } : {}),
    };
  }

  private nextTitle(workspaceId: string): string {
    const used = new Set(this.list(workspaceId).map((terminal) => terminal.title));
    let n = 1;
    while (used.has(`Terminal ${n}`)) n++;
    return `Terminal ${n}`;
  }

  private find(id: string): Live {
    const entry = this.live.get(id);
    if (!entry) {
      throw new ApiError(
        404,
        "terminal_not_found",
        `No terminal ${id}. Terminals end when the server stops.`,
      );
    }
    return entry;
  }
}
