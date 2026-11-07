import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, TEST_TOKEN, type TestServer } from "@pi-spore/server-core/testing";
import {
  CreateWorkspaceResponse,
  parse,
  Terminal,
  TerminalList,
  TerminalServerMessage,
  type Workspace,
} from "@pi-spore/shared";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createTerminalsModule, type TerminalsModuleOptions } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/shell.mjs", import.meta.url));
const TerminalBody = Type.Object({ terminal: Terminal });

let server: TestServer | undefined;
let scratch: string;
const sockets: WebSocket[] = [];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-terminals-")));
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  // Ends every shell a test left open, so none outlives it.
  if (server) {
    for (const workspace of await listWorkspaces()) {
      for (const terminal of await listTerminals(workspace.id)) {
        await server.request("DELETE", `/api/terminals/${terminal.id}`);
      }
    }
    server.close();
    server = undefined;
  }
  rmSync(scratch, { recursive: true, force: true });
});

async function start(options: TerminalsModuleOptions = {}): Promise<TestServer> {
  server = await createTestServer(
    [
      projectsModule,
      vcsFolderModule,
      workspacesModule,
      createTerminalsModule({
        shell: { command: process.execPath, args: [FIXTURE] },
        baseEnv: { PATH: process.env.PATH, ORCA_TERMINAL: "x", HERDR_PANE: "y", KEEP: "1" },
        ...options,
      }),
    ],
    { listen: true },
  );
  return server;
}

function api(): TestServer {
  if (!server) throw new Error("No server");
  return server;
}

async function json(response: Response, status = 200): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== status) {
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function errorOf(response: Response, status: number) {
  return ((await json(response, status)) as { error: { code: string; message: string } }).error;
}

async function listWorkspaces(): Promise<Workspace[]> {
  const body = (await json(await api().request("GET", "/api/workspaces"))) as {
    workspaces: Workspace[];
  };
  return body.workspaces;
}

async function listTerminals(workspaceId: string): Promise<Terminal[]> {
  const response = await api().request("GET", `/api/terminals/workspaces/${workspaceId}`);
  return parse(TerminalList, await json(response), "terminal list").terminals;
}

/** An in-place workspace on a plain folder project. */
async function workspace(): Promise<Workspace> {
  const dir = join(scratch, "project");
  mkdirSync(dir, { recursive: true });
  const project = (await json(
    await api().request("POST", "/api/projects", { path: dir }),
    201,
  )) as {
    project: { id: string };
  };
  const response = await api().request("POST", "/api/workspaces", {
    projectId: project.project.id,
    name: "Work",
    isolation: "in-place",
  });
  return parse(CreateWorkspaceResponse, await json(response, 201), "create workspace").workspace;
}

async function open(workspaceId: string, body: unknown = { cols: 100, rows: 30 }) {
  const response = await api().request("POST", `/api/terminals/workspaces/${workspaceId}`, body);
  return parse(TerminalBody, await json(response, 201), "terminal").terminal;
}

const socketUrl = (id: string, token = TEST_TOKEN) =>
  `${api().url.replace("http", "ws")}/api/terminals/${id}/socket?token=${token}`;

/** A browser's socket to a terminal: every frame it got, and a way to wait for one. */
async function connect(id: string) {
  const socket = new WebSocket(socketUrl(id));
  sockets.push(socket);
  const frames: TerminalServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    frames.push(parse(TerminalServerMessage, JSON.parse(String(data)), "frame"));
    for (const waiter of waiters.splice(0)) waiter();
  });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  /** All text the terminal showed, snapshot and output. */
  const text = () => frames.map((frame) => ("data" in frame ? frame.data : "")).join("");
  /** Resolves once `check` holds; rejects if no frame makes it hold within 10 s. */
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`Timed out waiting for ${what}; got ${JSON.stringify(text())}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  const type = (data: string) => socket.send(JSON.stringify({ type: "input", data }));
  return { socket, frames, text, until, type, closed };
}

/** The HTTP status a refused upgrade answered with. */
function refusedStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.on("open", () => reject(new Error("The upgrade was accepted")));
    socket.on("error", () => {});
  });
}

describe("terminals", () => {
  it("starts the shell in the workspace folder with the workspace env and the browser's size (R13.1)", async () => {
    await start();
    const ws = await workspace();
    const terminal = await open(ws.id);
    expect(terminal).toMatchObject({
      workspaceId: ws.id,
      title: "Terminal 1",
      shell: process.execPath,
      cols: 100,
      rows: 30,
      status: "running",
    });
    const view = await connect(terminal.id);
    await view.until(() => view.text().includes("READY"), "the shell to start");
    const ready = view.text();
    expect(ready).toContain(`cwd=${ws.path}`);
    expect(ready).toContain("size=100x30");
    const env = JSON.parse(/env=(\{.*\})/.exec(ready)?.[1] ?? "{}") as Record<string, string>;
    expect(env).toEqual({
      PI_SPORE_WORKSPACE_ID: ws.id,
      PI_SPORE_WORKSPACE_PATH: ws.path,
      PI_SPORE_PROJECT_ROOT: join(scratch, "project"),
      TERM: "xterm-256color",
    });

    const second = await open(ws.id, { cols: 80, rows: 24, title: "Logs" });
    expect(second.title).toBe("Logs");
    expect((await listTerminals(ws.id)).map((t) => t.title)).toEqual(["Terminal 1", "Logs"]);
  });

  it("sends input to the shell, output to the browser, and resizes the PTY", async () => {
    await start();
    const terminal = await open((await workspace()).id);
    const view = await connect(terminal.id);
    await view.until(() => view.text().includes("READY"), "the shell to start");

    view.type("say hello\r");
    await view.until(() => view.text().includes("said:hello"), "the answer");

    view.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await view.until(() => view.text().includes("resized 120x40"), "the resize");
    expect((await listTerminals(terminal.workspaceId))[0]).toMatchObject({ cols: 120, rows: 40 });
  });

  it("gives a reconnecting browser the scrollback, then live output (R13.2)", async () => {
    await start();
    const terminal = await open((await workspace()).id);
    const first = await connect(terminal.id);
    await first.until(() => first.text().includes("READY"), "the shell to start");
    first.type("say before\r");
    await first.until(() => first.text().includes("said:before"), "the first answer");
    first.socket.close();
    await first.closed;

    const second = await connect(terminal.id);
    await second.until(() => second.frames.length > 0, "the snapshot");
    expect(second.frames[0]?.type).toBe("snapshot");
    expect(second.text()).toContain("said:before");
    second.type("say after\r");
    await second.until(() => second.text().includes("said:after"), "live output");
  });

  it("keeps only the recent scrollback", async () => {
    await start({ scrollbackChars: 2000 });
    const terminal = await open((await workspace()).id);
    const first = await connect(terminal.id);
    first.type("big 2000\r");
    await first.until(() => first.text().includes("line 1999"), "the output");

    const second = await connect(terminal.id);
    await second.until(() => second.frames.length > 0, "the snapshot");
    const snapshot = second.frames[0];
    if (snapshot?.type !== "snapshot") throw new Error("No snapshot first");
    expect(snapshot.data.length).toBeLessThanOrEqual(2000);
    expect(snapshot.data).toContain("line 1999");
    expect(snapshot.data).not.toContain("READY");
    // The cut is at a line start.
    expect(snapshot.data).toMatch(/^line \d+\r/);
  });

  it("reports a shell that exits, and keeps the terminal until it is closed", async () => {
    await start();
    const terminal = await open((await workspace()).id);
    const view = await connect(terminal.id);
    await view.until(() => view.text().includes("READY"), "the shell to start");
    view.type("exit 3\r");
    await view.until(() => view.frames.some((frame) => frame.type === "exit"), "the exit");
    expect(view.frames.find((frame) => frame.type === "exit")).toEqual({
      type: "exit",
      exitCode: 3,
    });
    expect((await listTerminals(terminal.workspaceId))[0]).toMatchObject({
      status: "exited",
      exitCode: 3,
    });

    const later = await connect(terminal.id);
    await later.until(() => later.frames.length >= 2, "snapshot and exit");
    expect(later.frames.map((frame) => frame.type)).toEqual(["snapshot", "exit"]);
    later.type("say late\r");
    await later.until(() => later.frames.some((frame) => frame.type === "error"), "the error");
  });

  it("closes a terminal: the shell ends, sockets close, and it is gone", async () => {
    await start();
    const terminal = await open((await workspace()).id);
    const view = await connect(terminal.id);
    await view.until(() => view.text().includes("READY"), "the shell to start");
    expect(await listTerminals(terminal.workspaceId)).toHaveLength(1);

    const closed = parse(
      TerminalBody,
      await json(await api().request("DELETE", `/api/terminals/${terminal.id}`)),
      "closed",
    ).terminal;
    expect(closed.status).toBe("exited");
    expect(await view.closed).toBe(1000);
    expect(await listTerminals(terminal.workspaceId)).toEqual([]);
    expect(await refusedStatus(socketUrl(terminal.id))).toBe(404);
    expect(
      (await errorOf(await api().request("DELETE", `/api/terminals/${terminal.id}`), 404)).code,
    ).toBe("terminal_not_found");
  });

  it("closes a shell that ignores SIGHUP with SIGKILL", { timeout: 15_000 }, async () => {
    await start();
    const terminal = await open((await workspace()).id);
    const view = await connect(terminal.id);
    view.type("stubborn\r");
    await view.until(() => view.text().includes("stubborn now"), "the shell to ignore SIGHUP");
    const closed = parse(
      TerminalBody,
      await json(await api().request("DELETE", `/api/terminals/${terminal.id}`)),
      "closed",
    ).terminal;
    expect(closed.signal).toBe(9);
  });

  it("closes a workspace's terminals before it is parked or archived", async () => {
    await start();
    const ws = await workspace();
    const parked = await open(ws.id);
    const parkedView = await connect(parked.id);
    await json(await api().request("POST", `/api/workspaces/${ws.id}/park`));
    expect(await parkedView.closed).toBe(1000);
    expect(await listTerminals(ws.id)).toEqual([]);
    expect(
      (
        await errorOf(
          await api().request("POST", `/api/terminals/workspaces/${ws.id}`, { cols: 80, rows: 24 }),
          409,
        )
      ).code,
    ).toBe("workspace_not_active");

    await json(await api().request("POST", `/api/workspaces/${ws.id}/resume`));
    const archived = await open(ws.id);
    const archivedView = await connect(archived.id);
    await json(await api().request("POST", `/api/workspaces/${ws.id}/archive`, {}));
    expect(await archivedView.closed).toBe(1000);
    expect(await listTerminals(ws.id)).toEqual([]);
  });

  it("refuses more terminals than the limit", async () => {
    await start({ maxOpen: 1 });
    const ws = await workspace();
    await open(ws.id);
    const error = await errorOf(
      await api().request("POST", `/api/terminals/workspaces/${ws.id}`, { cols: 80, rows: 24 }),
      409,
    );
    expect(error.code).toBe("terminal_limit");
    expect((await api().request("GET", `/api/terminals/workspaces/${ws.id}`)).status).toBe(200);
    expect(
      parse(
        TerminalList,
        await json(await api().request("GET", `/api/terminals/workspaces/${ws.id}`)),
        "l",
      ).max,
    ).toBe(1);
  });

  it("opens only for the user's token, from loopback pages (R1.2, ADR 0032)", async () => {
    await start();
    const ws = await workspace();
    const terminal = await open(ws.id);
    const agentToken = api().agentTokens.issue({ agentId: "a1", workspaceId: ws.id });

    expect(await refusedStatus(socketUrl(terminal.id, "wrong"))).toBe(401);
    expect(await refusedStatus(socketUrl(terminal.id, agentToken))).toBe(401);
    expect(await refusedStatus(socketUrl(terminal.id), { origin: "https://evil.example" })).toBe(
      403,
    );
    const port = new URL(api().url).port;
    expect(await refusedStatus(socketUrl(terminal.id), { host: `evil.example:${port}` })).toBe(403);
    // HTTP routes refuse agent tokens too.
    const asAgent = await api().request("GET", `/api/terminals/workspaces/${ws.id}`, undefined, {
      "x-pi-spore-token": "",
      authorization: `Bearer ${agentToken}`,
    });
    expect(asAgent.status).toBe(401);
  });

  it("answers bad messages with an error frame and bad requests with 400", async () => {
    await start();
    const ws = await workspace();
    for (const body of [{ cols: 0, rows: 24 }, { cols: 80 }, { cols: 80, rows: 24, extra: 1 }]) {
      expect((await api().request("POST", `/api/terminals/workspaces/${ws.id}`, body)).status).toBe(
        400,
      );
    }
    const terminal = await open(ws.id);
    const view = await connect(terminal.id);
    view.socket.send("not json");
    view.socket.send(JSON.stringify({ type: "resize", cols: -1, rows: 5 }));
    view.socket.send(JSON.stringify({ type: "shout" }));
    await view.until(
      () => view.frames.filter((frame) => frame.type === "error").length === 3,
      "three errors",
    );
    const errors = view.frames.flatMap((frame) => (frame.type === "error" ? [frame.message] : []));
    expect(errors[0]).toBe("Terminal messages must be JSON");
    expect(errors[1]).toContain("Invalid terminal message");
    // The terminal still works.
    view.type("say ok\r");
    await view.until(() => view.text().includes("said:ok"), "the answer");
  });

  it("names SHELL when it is not set", async () => {
    server = await createTestServer(
      [projectsModule, vcsFolderModule, workspacesModule, createTerminalsModule({ baseEnv: {} })],
      { listen: true },
    );
    const ws = await workspace();
    const error = await errorOf(
      await api().request("POST", `/api/terminals/workspaces/${ws.id}`, { cols: 80, rows: 24 }),
      500,
    );
    expect(error).toEqual({
      code: "shell_not_set",
      message: "SHELL is not set in the server's environment; terminals run $SHELL",
    });
  });
});
