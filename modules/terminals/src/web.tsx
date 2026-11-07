import "@xterm/xterm/css/xterm.css";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  parse,
  TERMINAL_INPUT_MAX,
  type Terminal,
  TerminalList,
  Terminal as TerminalSchema,
  TerminalServerMessage,
  type Workspace,
} from "@pi-spore/shared";
import { Button, cn, EmptyState, Notice, Spinner, Tooltip, useTheme } from "@pi-spore/ui";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Type from "typebox";
import { terminalTheme } from "./theme.js";

const TerminalBody = Type.Object({ terminal: TerminalSchema });
const FONT = "'JetBrains Mono Variable', ui-monospace, monospace";
const FONT_SIZE = 13;
/** Size of a new terminal before the browser has measured one. The first resize fixes it. */
const FIRST_SIZE = { cols: 80, rows: 24 };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads role tokens as the colors the page shows now, through a hidden element. */
function readTheme() {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  try {
    const read = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    return terminalTheme(read, getComputedStyle(document.documentElement).colorScheme === "light");
  } finally {
    probe.remove();
  }
}

function exitText(terminal: Pick<Terminal, "exitCode" | "signal">): string {
  if (terminal.signal) return `ended by signal ${terminal.signal}`;
  return `exited with code ${terminal.exitCode ?? "?"}`;
}

/**
 * One terminal on screen. It connects to the terminal's socket, gets the scrollback, then live output. When the
 * socket drops it reconnects, unless the terminal is gone (closed, or the server restarted).
 */
function Screen({
  terminal,
  lastSize,
  onExit,
  onGone,
}: {
  terminal: Terminal;
  /** Remembers the fitted size, so the next new terminal starts at it. */
  lastSize: { current: { cols: number; rows: number } };
  onExit: () => void;
  onGone: () => void;
}) {
  const api = useApi();
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const xterm = useRef<Xterm | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  // The effect below runs once per terminal; these read the newest callbacks.
  const callbacks = useRef({ onExit, onGone });
  callbacks.current = { onExit, onGone };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = 500;
    const term = new Xterm({
      fontFamily: FONT,
      fontSize: FONT_SIZE,
      cursorBlink: true,
      scrollback: 5000,
      theme: readTheme(),
    });
    xterm.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);

    const send = (frame: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    const sendSize = () => {
      lastSize.current = { cols: term.cols, rows: term.rows };
      send({ type: "resize", ...lastSize.current });
    };
    term.onData((data) => {
      // The server takes input frames up to TERMINAL_INPUT_MAX characters; a long paste goes in pieces.
      for (let i = 0; i < data.length; i += TERMINAL_INPUT_MAX) {
        send({ type: "input", data: data.slice(i, i + TERMINAL_INPUT_MAX) });
      }
    });
    term.onResize(sendSize);

    const connect = () => {
      if (stopped) return;
      const current = new WebSocket(api.socketUrl(`terminals/${terminal.id}/socket`));
      socket = current;
      current.addEventListener("open", () => {
        backoff = 500;
        setConnected(true);
        sendSize();
      });
      current.addEventListener("message", (event) => {
        let frame: TerminalServerMessage;
        try {
          frame = parse(TerminalServerMessage, JSON.parse(String(event.data)), "terminal frame");
        } catch (error) {
          console.warn(`pi-spore: ${message(error)}`);
          return;
        }
        if (frame.type === "snapshot") {
          term.reset();
          term.write(frame.data);
        } else if (frame.type === "output") term.write(frame.data);
        else if (frame.type === "exit") {
          term.write(`\r\n\x1b[2m[The shell ${exitText(frame)}]\x1b[0m\r\n`);
          callbacks.current.onExit();
        } else console.warn(`pi-spore terminal: ${frame.message}`);
      });
      current.addEventListener("close", () => {
        if (stopped || socket !== current) return;
        setConnected(false);
        recover();
      });
    };

    // A refused upgrade looks like any other drop in a browser, so ask the server whether the terminal still exists.
    const recover = () => {
      retry = setTimeout(() => {
        void api
          .get(`terminals/workspaces/${terminal.workspaceId}`)
          .then((body) => {
            if (stopped) return;
            const list = parse(TerminalList, body, "terminal list");
            if (list.terminals.some((candidate) => candidate.id === terminal.id)) connect();
            else callbacks.current.onGone();
          })
          .catch(() => {
            // The server is down; try again later.
            if (!stopped) recover();
          });
      }, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };

    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    });
    // xterm measures the font when it opens, so the web font must be there first.
    void document.fonts.load(`${FONT_SIZE}px 'JetBrains Mono Variable'`).finally(() => {
      if (stopped) return;
      term.open(element);
      fit.fit();
      observer.observe(element);
      term.focus();
      connect();
    });

    return () => {
      stopped = true;
      clearTimeout(retry);
      observer.disconnect();
      socket?.close();
      term.dispose();
      xterm.current = undefined;
    };
  }, [api, terminal.id, terminal.workspaceId, lastSize]);

  // The theme menu changes the tokens; repaint with the new colors.
  useEffect(() => {
    if (theme && xterm.current) xterm.current.options.theme = readTheme();
  }, [theme]);

  return (
    <div className="relative min-h-0 flex-1 bg-panel">
      <div ref={host} className="absolute inset-0 py-1 pl-2" />
      {!connected && terminal.status === "running" && (
        <div className="absolute top-2 right-3 flex items-center gap-2 text-xs text-muted">
          <Spinner /> Connecting
        </div>
      )}
    </div>
  );
}

/** The Terminals tab: a tab per terminal of the workspace, new and close buttons, and the open terminal. */
function TerminalsTab({ workspace }: { workspace: Workspace }) {
  const api = useApi();
  const [terminals, setTerminals] = useState<Terminal[] | undefined>();
  const [max, setMax] = useState<number | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const lastSize = useRef(FIRST_SIZE);

  const load = useCallback(async () => {
    try {
      const list = parse(
        TerminalList,
        await api.get(`terminals/workspaces/${workspace.id}`),
        "terminal list",
      );
      setTerminals(list.terminals);
      setMax(list.max);
      setSelected((current) =>
        list.terminals.some((terminal) => terminal.id === current)
          ? current
          : list.terminals.at(-1)?.id,
      );
    } catch (failure) {
      setError(message(failure));
    }
  }, [api, workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { terminal } = parse(
        TerminalBody,
        await api.send("POST", `terminals/workspaces/${workspace.id}`, lastSize.current),
        "terminal",
      );
      setTerminals((current) => [...(current ?? []), terminal]);
      setSelected(terminal.id);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  const close = async (terminal: Terminal) => {
    setError(undefined);
    try {
      await api.send("DELETE", `terminals/${terminal.id}`);
    } catch (failure) {
      setError(message(failure));
    }
    await load();
  };

  if (workspace.state !== "active") {
    return (
      <EmptyState icon={SquareTerminal} title="No terminals">
        Resume the workspace to open terminals.
      </EmptyState>
    );
  }
  if (!terminals) {
    return error ? (
      <Notice tone="fail" className="m-3">
        {error}
      </Notice>
    ) : (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  const current = terminals.find((terminal) => terminal.id === selected);
  const newButton = (
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void create()}>
      <Plus /> New terminal
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {terminals.map((terminal) => (
            <div
              key={terminal.id}
              className={cn(
                "flex shrink-0 items-center rounded-md text-sm",
                terminal.id === selected ? "bg-raised text-fg" : "text-muted hover:text-fg",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={terminal.id === selected}
                className="flex cursor-pointer items-center gap-1.5 py-1 pl-2"
                onClick={() => setSelected(terminal.id)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    terminal.status === "running" ? "bg-ok" : "bg-muted",
                  )}
                />
                {terminal.title}
                {terminal.status === "exited" && <span className="sr-only">(ended)</span>}
              </button>
              <Tooltip label={`Close ${terminal.title}`}>
                <button
                  type="button"
                  aria-label={`Close ${terminal.title}`}
                  className="cursor-pointer rounded p-1 text-muted hover:text-fg"
                  onClick={() => void close(terminal)}
                >
                  <X className="size-3.5" />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
        <Tooltip label="New terminal">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New terminal"
            disabled={busy || (max !== undefined && terminals.length >= max)}
            onClick={() => void create()}
          >
            <Plus />
          </Button>
        </Tooltip>
      </div>
      {error && (
        <Notice tone="fail" className="m-2">
          {error}
        </Notice>
      )}
      {current ? (
        <Screen
          key={current.id}
          terminal={current}
          lastSize={lastSize}
          onExit={() => void load()}
          onGone={() => void load()}
        />
      ) : (
        <EmptyState icon={SquareTerminal} title="No terminals" action={newButton}>
          A shell in this workspace's folder. It keeps running when you reload the page.
        </EmptyState>
      )}
      <p className="shrink-0 border-t border-line px-3 py-1.5 text-xs text-muted">
        Terminals keep running across page reloads. They end when the server stops.
      </p>
    </div>
  );
}

export const terminalsWeb: WebModule = {
  id: "terminals",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    host.use(WorkspaceViewKey).addTab({
      id: "terminals",
      title: "Terminals",
      order: 10,
      wide: true,
      component: TerminalsTab,
    });
  },
};
