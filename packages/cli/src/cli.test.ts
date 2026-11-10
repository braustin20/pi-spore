import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliDeps, run } from "./cli.js";

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const NOW = 1_000_000_000;

/** A fake server: `answer` maps "METHOD /path" to a response. Every request is recorded. */
function fakeDeps(
  answer: (key: string, sent: Sent) => Response | Promise<Response>,
  overrides: Partial<CliDeps> = {},
) {
  const out: string[] = [];
  const written: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  let keys = 0;
  const deps: CliDeps = {
    fetch: (async (input: URL, init?: RequestInit) => {
      const url = new URL(input);
      const request: Sent = {
        method: init?.method ?? "GET",
        url: url.toString(),
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      };
      sent.push(request);
      return answer(`${request.method} ${url.pathname}${url.search}`, request);
    }) as typeof fetch,
    env: {},
    out: (line) => out.push(line),
    write: (text) => written.push(text),
    err: (line) => err.push(line),
    readToken: () => "secret",
    resolvePath: (path) => (path.startsWith("/") ? path : `/home/me/${path}`),
    newKey: () => `key-${++keys}`,
    now: () => NOW,
    ...overrides,
  };
  return { deps, out, written, err, sent };
}

const project = {
  id: "P1",
  name: "Game",
  slug: "game",
  path: "/home/me/game",
  vcs: "git",
  traits: [{ id: "unity", detail: "6000.3.10f1" }],
  createdAt: 1,
};
const workspace = {
  id: "W1",
  projectId: "P1",
  name: "Fix UI",
  slug: "fix-ui",
  isolation: "new",
  path: "/home/me/.pi-spore/worktrees/game/fix-ui-abc123",
  line: "spore/fix-ui-abc123",
  state: "active",
  createdAt: 2,
  updatedAt: 2,
};

const healthy = () =>
  Response.json({ status: "ok", version: "0.1.0", uptimeMs: 65_400, modules: ["projects"] });

describe("pi-spore health", () => {
  it("prints a one-line summary from the default address, without a token", async () => {
    const { deps, out, sent } = fakeDeps(healthy, { readToken: () => undefined });

    expect(await run(["health"], deps)).toBe(0);
    expect(sent.map((request) => request.url)).toEqual(["http://127.0.0.1:7420/api/health"]);
    expect(out).toEqual(["ok  version 0.1.0  up 65s  modules: projects"]);
  });

  it("prints the raw response with --json", async () => {
    const { deps, out } = fakeDeps(healthy);
    expect(await run(["health", "--json"], deps)).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ status: "ok", version: "0.1.0" });
  });

  it("uses PI_SPORE_URL when set", async () => {
    const { deps, sent } = fakeDeps(healthy, { env: { PI_SPORE_URL: "http://127.0.0.1:9999" } });
    await run(["health"], deps);
    expect(sent[0]?.url).toBe("http://127.0.0.1:9999/api/health");
  });

  it("fails with exit 1 when the server is not reachable", async () => {
    const { deps, err } = fakeDeps(() => Promise.reject(new TypeError("fetch failed")));
    expect(await run(["health"], deps)).toBe(1);
    expect(err[0]).toContain("pi-spore server is not reachable at http://127.0.0.1:7420");
  });

  it("fails with exit 1 on an error status", async () => {
    const { deps, err } = fakeDeps(
      () => new Response("", { status: 500, statusText: "Internal Server Error" }),
    );
    expect(await run(["health"], deps)).toBe(1);
    expect(err[0]).toContain("answered 500 Internal Server Error");
  });

  it("fails with exit 1 on a response that does not match the schema", async () => {
    const { deps, err } = fakeDeps(() => Response.json({ status: "ok" }));
    expect(await run(["health"], deps)).toBe(1);
    expect(err[0]).toContain("sent a bad health response");
  });
});

const remoteSettings = (hosts: string[], logins: string[]) => () =>
  Response.json({
    settings: [
      {
        key: "server.allowedHosts",
        value: hosts,
        source: hosts.length > 0 ? "global" : "default",
      },
      {
        key: "server.allowedLogins",
        value: logins,
        source: logins.length > 0 ? "global" : "default",
      },
    ],
  });

describe("pi-spore remote", () => {
  it("says access is off and names settings.json when no host is allowed", async () => {
    const { deps, out } = fakeDeps(remoteSettings([], []));

    expect(await run(["remote"], deps)).toBe(0);
    expect(out[0]).toBe("Remote access is off.");
    const text = out.join("\n");
    expect(text).toContain("tailscale status --json");
    expect(text).toContain("~/.pi-spore/settings.json");
    expect(text).toContain('"allowedHosts"');
  });

  it("prints the serve command and one URL per allowed host", async () => {
    const { deps, out } = fakeDeps(
      remoteSettings(
        ["box.tail.ts.net", "desk.tail.ts.net"],
        ["me@example.com", "you@example.com"],
      ),
    );

    expect(await run(["remote"], deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("tailscale serve --bg 7420");
    expect(out).toContain("Open: https://box.tail.ts.net/");
    expect(out).toContain("Open: https://desk.tail.ts.net/");
    expect(text).toContain("Allowed logins: me@example.com, you@example.com");
    expect(text).toContain("tailscale serve --https=443 off");
    expect(text).toContain("Never use tailscale funnel");
  });

  it("uses the port from PI_SPORE_URL", async () => {
    const { deps, out } = fakeDeps(remoteSettings(["box.tail.ts.net"], ["me@example.com"]), {
      env: { PI_SPORE_URL: "http://127.0.0.1:7500" },
    });

    await run(["remote"], deps);
    expect(out[0]).toContain("tailscale serve --bg 7500");
  });

  it("prints port, settings, the serve command, and the urls with --json", async () => {
    const { deps, out } = fakeDeps(remoteSettings(["box.tail.ts.net"], ["me@example.com"]));

    expect(await run(["remote", "--json"], deps)).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual({
      port: 7420,
      allowedHosts: ["box.tail.ts.net"],
      allowedLogins: ["me@example.com"],
      serve: "tailscale serve --bg 7420",
      urls: ["https://box.tail.ts.net/"],
    });
  });

  it("reads settings with the token header", async () => {
    const { deps, sent } = fakeDeps(remoteSettings([], []));

    await run(["remote"], deps);
    expect(sent[0]).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:7420/api/projects/settings",
      headers: { "x-pi-spore-token": "secret" },
    });
  });

  it("fails when the server does not report server.allowedHosts", async () => {
    const { deps, err } = fakeDeps(() => Response.json({ settings: [] }));

    expect(await run(["remote"], deps)).toBe(1);
    expect(err[0]).toContain("server.allowedHosts");
  });

  it("asks for a port when PI_SPORE_URL has none", async () => {
    const { deps, err } = fakeDeps(remoteSettings(["box.tail.ts.net"], ["me@example.com"]), {
      env: { PI_SPORE_URL: "http://127.0.0.1" },
    });

    expect(await run(["remote"], deps)).toBe(1);
    expect(err[0]).toContain("port");
  });
});

describe("pi-spore project", () => {
  it("adds a project from a relative path with the token and an idempotency key", async () => {
    const { deps, out, sent } = fakeDeps(() => Response.json({ project }, { status: 201 }));

    expect(await run(["project", "add", "game", "--name", "Game"], deps)).toBe(0);

    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7420/api/projects",
      headers: { "x-pi-spore-token": "secret", "idempotency-key": "key-1" },
      body: { path: "/home/me/game", name: "Game" },
    });
    expect(out[0]).toContain("Added game");
    expect(out[0]).toContain("[unity 6000.3.10f1]");
  });

  it("lists projects, or says how to add one", async () => {
    const one = fakeDeps(() => Response.json({ projects: [project] }));
    await run(["project", "list"], one.deps);
    expect(one.out[0]).toMatch(/^game\s+git\s+\/home\/me\/game/);

    const none = fakeDeps(() => Response.json({ projects: [] }));
    await run(["project", "list"], none.deps);
    expect(none.out[0]).toContain("pi-spore project add <path>");
  });

  it("removes a project found by slug", async () => {
    const { deps, sent } = fakeDeps((key) =>
      key === "GET /api/projects"
        ? Response.json({ projects: [project] })
        : Response.json({ removed: "P1" }),
    );
    expect(await run(["project", "rm", "game"], deps)).toBe(0);
    expect(sent[1]).toMatchObject({
      method: "DELETE",
      url: "http://127.0.0.1:7420/api/projects/P1",
    });
  });

  it("shows the server's error message and exits 1", async () => {
    const { deps, err } = fakeDeps(() =>
      Response.json(
        { error: { code: "project_exists", message: "/home/me/game is already registered" } },
        { status: 409 },
      ),
    );
    expect(await run(["project", "add", "/home/me/game"], deps)).toBe(1);
    expect(err).toEqual(["/home/me/game is already registered"]);
  });

  it("explains a missing token", async () => {
    const { deps, err, sent } = fakeDeps(healthy, { readToken: () => undefined });
    expect(await run(["project", "list"], deps)).toBe(1);
    expect(err[0]).toContain("No API token");
    expect(sent).toEqual([]);
  });

  it("names an unknown project", async () => {
    const { deps, err } = fakeDeps(() => Response.json({ projects: [project] }));
    expect(await run(["project", "rm", "nope"], deps)).toBe(1);
    expect(err[0]).toContain('No project "nope"');
  });
});

describe("pi-spore ws", () => {
  it("creates a workspace, prints warnings to stderr, and lists the copied files", async () => {
    const { deps, out, err, sent } = fakeDeps((key) =>
      key === "GET /api/projects"
        ? Response.json({ projects: [project] })
        : Response.json(
            {
              workspace,
              copied: ["Library", "game.sln"],
              warnings: ["Unity may have the main project open."],
              steps: [{ name: "setup", ok: true, message: "setup succeeded" }],
            },
            { status: 201 },
          ),
    );

    expect(await run(["ws", "new", "game", "Fix", "UI"], deps)).toBe(0);

    expect(sent[1]?.body).toEqual({ projectId: "P1", name: "Fix UI", isolation: "new" });
    expect(err).toEqual(["warning: Unity may have the main project open."]);
    expect(out[0]).toContain("Created W1");
    expect(out[1]).toBe("Copied: Library, game.sln");
    expect(out[2]).toBe("setup succeeded");
  });

  it("exits 1 when setup failed, after it printed the new workspace", async () => {
    const { deps, out, err } = fakeDeps((key) =>
      key === "GET /api/projects"
        ? Response.json({ projects: [project] })
        : Response.json(
            {
              workspace,
              copied: [],
              warnings: [],
              steps: [
                {
                  name: "setup",
                  ok: false,
                  message: "setup failed with exit code 2; log: /logs/R1.log",
                  runId: "R1",
                  logPath: "/logs/R1.log",
                },
              ],
            },
            { status: 201 },
          ),
    );
    expect(await run(["ws", "new", "game", "x"], deps)).toBe(1);
    expect(out[0]).toContain("Created W1");
    expect(err).toEqual(["setup failed with exit code 2; log: /logs/R1.log"]);
  });

  it("passes the mode and branch for an existing branch", async () => {
    const { deps, sent } = fakeDeps((key) =>
      key === "GET /api/projects"
        ? Response.json({ projects: [project] })
        : Response.json({ workspace, copied: [], warnings: [], steps: [] }, { status: 201 }),
    );
    await run(["ws", "new", "game", "x", "--mode", "existing", "--line", "feature/x"], deps);
    expect(sent[1]?.body).toEqual({
      projectId: "P1",
      name: "x",
      isolation: "existing",
      line: "feature/x",
    });
  });

  it("rejects an unknown mode before calling the server", async () => {
    const { deps, sent } = fakeDeps(healthy);
    expect(await run(["ws", "new", "game", "x", "--mode", "copy"], deps)).toBe(2);
    expect(sent).toEqual([]);
  });

  it("filters the list by project slug and state", async () => {
    const { deps, sent, out } = fakeDeps((key) =>
      key === "GET /api/projects"
        ? Response.json({ projects: [project] })
        : Response.json({ workspaces: [workspace] }),
    );
    await run(["ws", "list", "--project", "game", "--state", "active"], deps);
    expect(sent[1]?.url).toBe("http://127.0.0.1:7420/api/workspaces?projectId=P1&state=active");
    expect(out[0]).toContain("W1  active");
  });

  it("archives with --force", async () => {
    const { deps, sent } = fakeDeps(() =>
      Response.json({
        workspace: { ...workspace, state: "archived" },
        steps: [{ name: "teardown", ok: false, message: "teardown failed with exit code 1" }],
      }),
    );
    // Forced past a failed teardown: archived, but the failure still shows in the exit code.
    expect(await run(["ws", "archive", "W1", "--force"], deps)).toBe(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7420/api/workspaces/W1/archive",
      body: { force: true },
    });
  });

  it("renames, parks, and resumes", async () => {
    const { deps, sent } = fakeDeps(() => Response.json({ workspace }));
    await run(["ws", "rename", "W1", "New", "name"], deps);
    await run(["ws", "park", "W1"], deps);
    await run(["ws", "resume", "W1"], deps);
    expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "PATCH /api/workspaces/W1",
      "POST /api/workspaces/W1/park",
      "POST /api/workspaces/W1/resume",
    ]);
    expect(sent[0]?.body).toEqual({ name: "New name" });
  });
});

const actionRun = {
  id: "R1",
  workspaceId: "W1",
  action: "test",
  trigger: "user",
  status: "running",
  logPath: "/logs/actions/W1/R1.log",
  createdAt: 3,
  startedAt: 3,
};

describe("pi-spore action", () => {
  it("lists actions with their command and source", async () => {
    const { deps, out, sent } = fakeDeps(() =>
      Response.json({
        actions: [
          {
            name: "dev",
            run: "npm run dev",
            shell: true,
            exclusive: false,
            source: "local override",
          },
          {
            name: "test",
            run: ["npm", "test"],
            shell: false,
            exclusive: true,
            source: "project file",
          },
        ],
      }),
    );
    expect(await run(["action", "list", "W1"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/actions/workspaces/W1");
    expect(out).toEqual([
      "dev              sh -c npm run dev  (local override)",
      "test             npm test  (project file)  [exclusive]",
    ]);
  });

  it("runs an action and follows its log until it ends", async () => {
    const pages = [
      { run: actionRun, text: "$ npm test\n", start: 0, end: 11, size: 11 },
      {
        run: { ...actionRun, status: "succeeded", exitCode: 0, endedAt: 4 },
        text: "ok\n",
        start: 11,
        end: 14,
        size: 14,
      },
    ];
    const { deps, written, sent } = fakeDeps((key) =>
      key.startsWith("POST")
        ? Response.json({ run: actionRun }, { status: 201 })
        : Response.json(pages.shift()),
    );
    expect(await run(["action", "run", "W1", "test"], deps)).toBe(0);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7420/api/actions/workspaces/W1/runs",
      body: { action: "test" },
    });
    expect(sent.slice(1).map((request) => new URL(request.url).search)).toEqual([
      "?from=0&wait=15000",
      "?from=11&wait=15000",
    ]);
    expect(written.join("")).toBe("$ npm test\nok\n");
  });

  it("exits 1 when the action fails", async () => {
    const { deps, err } = fakeDeps((key) =>
      key.startsWith("POST")
        ? Response.json({ run: actionRun }, { status: 201 })
        : Response.json({
            run: { ...actionRun, status: "failed", exitCode: 3 },
            text: "",
            start: 0,
            end: 0,
            size: 0,
          }),
    );
    expect(await run(["action", "run", "W1", "test"], deps)).toBe(1);
    expect(err.at(-1)).toBe("Action test failed (exit code 3)");
  });
});

const chatOf = (id: string, extra: Record<string, unknown>) => ({
  id,
  workspaceId: "W1",
  role: "orchestrator",
  kind: "worker",
  active: true,
  status: "idle",
  createdAt: 1,
  ...extra,
});

describe("pi-spore chat", () => {
  it("lists a workspace's chats in the server's order", async () => {
    const { deps, out, sent } = fakeDeps(() =>
      Response.json({
        agents: [
          chatOf("A1", { title: "Fix the jump" }),
          chatOf("A2", { kind: "side", status: "stopped", forkedFrom: "A1" }),
          chatOf("A0", { active: false, status: "stopped", title: "First try" }),
        ],
      }),
    );
    expect(await run(["chat", "list", "W1"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/agents?workspaceId=W1");
    expect(out).toEqual([
      "A1  worker  idle      Fix the jump",
      "A2  side    stopped   (no messages yet)  (from A1)",
      "A0  older   stopped   First try",
    ]);
  });

  it("starts a worker chat, a side chat, or a forked side chat", async () => {
    const { deps, out, sent } = fakeDeps(() =>
      Response.json({ agent: chatOf("A3", { kind: "side", forkedFrom: "A1" }) }, { status: 201 }),
    );
    expect(await run(["chat", "new", "W1"], deps)).toBe(0);
    expect(await run(["chat", "new", "W1", "--side"], deps)).toBe(0);
    expect(await run(["chat", "new", "W1", "--side", "--fork"], deps)).toBe(0);
    expect(sent.map((request) => [request.method, request.url, request.body])).toEqual([
      ["POST", "http://127.0.0.1:7420/api/agents/chats", { workspaceId: "W1", kind: "worker" }],
      ["POST", "http://127.0.0.1:7420/api/agents/chats", { workspaceId: "W1", kind: "side" }],
      [
        "POST",
        "http://127.0.0.1:7420/api/agents/chats",
        { workspaceId: "W1", kind: "side", fork: true },
      ],
    ]);
    expect(out[0]).toBe("Started A3  side    idle      (no messages yet)  (from A1)");
  });

  it("rejects --fork without --side before calling the server", async () => {
    const { deps, err, sent } = fakeDeps(healthy);
    expect(await run(["chat", "new", "W1", "--fork"], deps)).toBe(2);
    expect(err[0]).toContain("--fork needs --side");
    expect(sent).toEqual([]);
  });
});

const card = {
  id: "C1",
  title: "Fix UI",
  body: "",
  projectId: "P1",
  labels: ["ui"],
  due: "2026-11-10",
  column: "backlog",
  position: 0,
  blockedBy: [],
  blocked: false,
  createdAt: 3,
  updatedAt: 3,
};

describe("pi-spore card", () => {
  it("lists cards, filtered by project", async () => {
    const { deps, out, sent } = fakeDeps((key) =>
      key.startsWith("GET /api/projects")
        ? Response.json({ projects: [project] })
        : Response.json({
            cards: [
              card,
              {
                ...card,
                id: "C2",
                title: "Notes",
                projectId: undefined,
                labels: [],
                due: undefined,
                blocked: true,
              },
            ],
          }),
    );
    expect(await run(["card", "list", "--project", "game"], deps)).toBe(0);
    expect(sent.map((request) => request.url)).toContain(
      "http://127.0.0.1:7420/api/kanban/cards?projectId=P1",
    );
    expect(out).toEqual([
      "C1  backlog     game             Fix UI  due 2026-11-10  [ui]",
      "C2  backlog     -                Notes  blocked",
    ]);
  });

  it("adds a card with a project and a due date", async () => {
    const { deps, out, sent } = fakeDeps((key) =>
      key.startsWith("GET /api/projects")
        ? Response.json({ projects: [project] })
        : Response.json({ card }, { status: 201 }),
    );
    expect(
      await run(["card", "add", "Fix", "UI", "--project", "game", "--due", "2026-11-10"], deps),
    ).toBe(0);
    const post = sent.find((request) => request.method === "POST");
    expect(post?.body).toEqual({ title: "Fix UI", projectId: "P1", due: "2026-11-10" });
    expect(post?.headers["idempotency-key"]).toBe("key-1");
    expect(out[0]).toContain("Added C1  backlog     game");
  });

  it("moves a card and checks the column first", async () => {
    const { deps, out, err, sent } = fakeDeps((key) =>
      key.startsWith("GET /api/projects")
        ? Response.json({ projects: [project] })
        : Response.json({ card: { ...card, column: "review" } }),
    );
    expect(await run(["card", "move", "C1", "later"], deps)).toBe(2);
    expect(err[0]).toContain("The column must be one of backlog, ready, in-progress, review, done");
    expect(sent).toEqual([]);

    expect(await run(["card", "move", "C1", "review"], deps)).toBe(0);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7420/api/kanban/cards/C1/move",
      body: { column: "review" },
    });
    expect(out[0]).toContain("Moved C1  review");
  });
});

describe("pi-spore card start", () => {
  const started = { card: { ...card, column: "in-progress" }, workspace, chatId: "A1" };

  it("starts a card in an existing workspace", async () => {
    const { deps, out, sent } = fakeDeps((key) =>
      key.startsWith("GET /api/projects")
        ? Response.json({ projects: [project] })
        : Response.json(started, { status: 201 }),
    );
    expect(await run(["card", "start", "C1", "--workspace", "W1"], deps)).toBe(0);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7420/api/kanban/cards/C1/start",
      body: { workspaceId: "W1" },
    });
    expect(out).toEqual([
      "Started C1  in-progress game             Fix UI  due 2026-11-10  [ui]",
      "In W1  active   Fix UI  spore/fix-ui-abc123  /home/me/.pi-spore/worktrees/game/fix-ui-abc123",
      "Brief sent to chat A1",
    ]);
  });

  it("starts a card in a new workspace, and refuses a missing or mixed target first", async () => {
    const { deps, err, sent } = fakeDeps((key) =>
      key.startsWith("GET /api/projects")
        ? Response.json({ projects: [project] })
        : Response.json(
            { ...started, created: { workspace, copied: [], warnings: [], steps: [] } },
            { status: 201 },
          ),
    );
    expect(await run(["card", "start", "C1"], deps)).toBe(2);
    expect(await run(["card", "start", "C1", "--new", "--workspace", "W1"], deps)).toBe(2);
    expect(await run(["card", "start", "C1", "--workspace", "W1", "--mode", "new"], deps)).toBe(2);
    expect(err[0]).toContain("one of --new, --workspace <id>, or --run");
    expect(sent).toEqual([]);

    expect(
      await run(["card", "start", "C1", "--new", "--mode", "in-place", "--blocked-ok"], deps),
    ).toBe(0);
    expect(sent[0]?.body).toEqual({ isolation: "in-place", confirmBlocked: true });
  });

  it("starts a card as a new run, and refuses a run mixed with other targets or options", async () => {
    const run1 = {
      id: "R1",
      projectId: "P1",
      workspaceId: "W1",
      line: "spore/fix-ui-abc123",
      base: "develop",
      gates: [],
      state: "running",
      coordinatorAgentId: "A1",
      createdAt: 2,
      lanes: [],
      questions: [],
    };
    const { deps, out, err, sent } = fakeDeps((key) =>
      key.startsWith("GET /api/projects")
        ? Response.json({ projects: [project] })
        : Response.json({ ...started, run: run1 }, { status: 201 }),
    );
    for (const bad of [
      ["--run", "--new"],
      ["--run", "--workspace", "W1"],
      ["--run", "--mode", "new"],
      ["--run", "--line", "feature"],
    ]) {
      expect(await run(["card", "start", "C1", ...bad], deps)).toBe(2);
    }
    expect(err[0]).toContain("one of --new, --workspace <id>, or --run");
    expect(err[3]).toContain("--run takes --base only");
    expect(sent).toEqual([]);

    expect(
      await run(["card", "start", "C1", "--run", "--base", "develop", "--blocked-ok"], deps),
    ).toBe(0);
    expect(sent[0]?.body).toEqual({ run: true, base: "develop", confirmBlocked: true });
    expect(out.slice(1)).toEqual([
      "In run R1 (W1  active   Fix UI  spore/fix-ui-abc123  /home/me/.pi-spore/worktrees/game/fix-ui-abc123)",
      "Brief sent to coordinator chat A1",
    ]);
  });
});

describe("pi-spore approvals", () => {
  const approval = {
    id: "AP1",
    kind: "card-start",
    agentId: "A1",
    workspaceId: "W1",
    title: 'Start card "Fix UI" in a new workspace (new worktree or copy)',
    reason: "Phase 1 is next",
    subject: { cardId: "C1", target: { kind: "new", isolation: "new" } },
    state: "open",
    createdAt: 5,
  };

  it("lists open approvals", async () => {
    const { deps, out, sent } = fakeDeps(() => Response.json({ approvals: [approval] }));
    expect(await run(["approvals", "list"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/attention/approvals?state=open");
    expect(out).toEqual([
      'AP1  Start card "Fix UI" in a new workspace (new worktree or copy)\n    reason: Phase 1 is next',
    ]);
  });

  it("approves and declines with a note", async () => {
    const { deps, out, sent } = fakeDeps((key) =>
      key.endsWith("/approve")
        ? Response.json({ approval: { ...approval, state: "approved", outcome: "Started." } })
        : Response.json({ approval: { ...approval, state: "declined", outcome: "Later" } }),
    );
    expect(await run(["approvals", "approve", "AP1"], deps)).toBe(0);
    expect(await run(["approvals", "decline", "AP1", "--note", "Later"], deps)).toBe(0);
    expect(sent.map((request) => [request.url, request.body])).toEqual([
      ["http://127.0.0.1:7420/api/attention/approvals/AP1/approve", {}],
      ["http://127.0.0.1:7420/api/attention/approvals/AP1/decline", { note: "Later" }],
    ]);
    expect(out).toEqual(["Approved AP1: Started.", "Declined AP1"]);
  });
});

describe("pi-spore jobs", () => {
  const job = {
    id: "J1",
    kind: "workspaces.pr-watch",
    key: "W1",
    subject: {},
    state: "interrupted",
    step: "poll",
    attempts: 1,
    error: "Server stopped",
    runAt: null,
    createdAt: 1,
    updatedAt: 2,
  };

  it("lists jobs that have not ended, one line each", async () => {
    const { deps, out, sent } = fakeDeps(() =>
      Response.json({ jobs: [job, { ...job, id: "J2", state: "running", error: null }] }),
    );
    expect(await run(["jobs"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/jobs");
    expect(out).toEqual([
      "J1  workspaces.pr-watch  interrupted  poll  Server stopped",
      "J2  workspaces.pr-watch  running  poll",
    ]);
  });

  it("asks for every state with --all", async () => {
    const { deps, sent } = fakeDeps(() => Response.json({ jobs: [] }));
    expect(await run(["jobs", "--all"], deps)).toBe(0);
    expect(sent[0]?.url).toBe(
      "http://127.0.0.1:7420/api/jobs?state=running&state=waiting&state=interrupted&state=done&state=cancelled",
    );
  });

  it("retries and cancels a job and prints its new state", async () => {
    const { deps, out, sent } = fakeDeps((key) =>
      Response.json({ ...job, state: key.endsWith("/retry") ? "running" : "cancelled" }),
    );
    expect(await run(["jobs", "retry", "J1"], deps)).toBe(0);
    expect(await run(["jobs", "cancel", "J1"], deps)).toBe(0);
    expect(sent.map((request) => request.url)).toEqual([
      "http://127.0.0.1:7420/api/jobs/J1/retry",
      "http://127.0.0.1:7420/api/jobs/J1/cancel",
    ]);
    expect(out).toEqual(["J1 is now running", "J1 is now cancelled"]);
  });

  it("rejects a job answer of the wrong shape", async () => {
    const { deps } = fakeDeps(() => Response.json({ jobs: [{ id: "J1" }] }));
    expect(await run(["jobs"], deps)).not.toBe(0);
  });
});

describe("pi-spore usage", () => {
  it("prints usage and exits 2 with no command", async () => {
    const { deps, out } = fakeDeps(healthy);
    expect(await run([], deps)).toBe(2);
    expect(out[0]).toContain("Usage: pi-spore");
  });

  it("rejects unknown commands and options with exit 2", async () => {
    const { deps, err } = fakeDeps(healthy);
    expect(await run(["frobnicate"], deps)).toBe(2);
    expect(err[0]).toContain("Unknown command: frobnicate");
    expect(await run(["ws", "list", "--nope"], deps)).toBe(2);
    expect(err[1]).toContain("Unknown option --nope");
  });
});

describe("pi-spore ws diff", () => {
  const diffs = {
    diffs: [
      {
        file: { path: "a.txt", status: "modified", additions: 1, deletions: 1, binary: false },
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            section: "fn main",
            lines: [
              { kind: "context", oldLine: 1, newLine: 1, text: "one" },
              { kind: "del", oldLine: 2, text: "two" },
              { kind: "add", newLine: 2, text: "TWO", noNewline: true },
            ],
          },
        ],
      },
      {
        file: { path: "pic.png", status: "added", additions: 0, deletions: 0, binary: true },
        hunks: [],
        note: "binary",
      },
    ],
    truncated: true,
  };

  it("prints each file as a unified diff, with notes for binary files", async () => {
    const { deps, out, err, sent } = fakeDeps(() => Response.json(diffs));
    expect(await run(["ws", "diff", "W1", "--commits"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/changes/workspaces/W1/diff?scope=line");
    expect(out).toEqual([
      "M a.txt  +1 -1",
      "@@ -1,2 +1,2 @@ fn main",
      " one",
      "-two",
      "+TWO",
      "\\ No newline at end of file",
      "",
      "A pic.png  +0 -0",
      "  (binary file)",
      "",
    ]);
    expect(err).toEqual(["More files changed than shown."]);
  });

  it("picks staged changes or one commit, but not both", async () => {
    const { deps, sent } = fakeDeps(() => Response.json({ diffs: [], truncated: false }));
    expect(await run(["ws", "diff", "W1", "--staged"], deps)).toBe(0);
    expect(await run(["ws", "diff", "W1", "--commit", "abc123"], deps)).toBe(0);
    expect(sent.map((request) => new URL(request.url).search)).toEqual([
      "?scope=staged",
      "?scope=record&record=abc123",
    ]);
    expect(await run(["ws", "diff", "W1", "--staged", "--commits"], deps)).toBe(2);
  });
});

describe("pi-spore pr", () => {
  const status = {
    workspaceId: "W1",
    publishable: true,
    defaults: { title: "Fix UI", body: "From the card", base: "main" },
    mergeWhenReady: false,
    watch: { state: "off", tries: 0, maxTries: 3 },
    tries: [],
    local: { headId: "h1", uncommitted: 0 },
  };
  const opened = {
    ...status,
    pr: {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      title: "Fix UI",
      state: "open",
      draft: false,
      line: "spore/fix-ui",
      base: "main",
      headId: "h1",
      review: "review_required",
      mergeable: "conflicting",
      checks: [
        { name: "test", workflow: "CI", state: "fail", url: "https://ci/1" },
        { name: "lint", state: "pending" },
      ],
    },
    watch: {
      state: "waiting",
      tries: 3,
      maxTries: 3,
      message: "Stopped after 3 automatic tries in a row. Waiting for you.",
    },
    local: { headId: "h2", uncommitted: 2 },
  };

  it("opens a PR with the defaults and an explicit confirm", async () => {
    const { deps, out, sent } = fakeDeps((key) =>
      key.startsWith("GET") ? Response.json(status) : Response.json(opened, { status: 201 }),
    );
    expect(await run(["pr", "open", "W1", "--title", "Better UI", "--draft"], deps)).toBe(0);
    const post = sent.find((request) => request.method === "POST");
    expect(post?.url).toBe("http://127.0.0.1:7420/api/github-pr/workspaces/W1/publish");
    expect(post?.body).toEqual({
      title: "Better UI",
      body: "From the card",
      base: "main",
      draft: true,
      confirm: true,
    });
    expect(out[0]).toBe("#7 open  spore/fix-ui -> main  https://github.com/o/r/pull/7");
  });

  it("shows the PR, its checks, conflicts, and a watch that waits", async () => {
    const { deps, out, sent } = fakeDeps(() => Response.json(opened));
    expect(await run(["pr", "status", "W1"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/github-pr/workspaces/W1?refresh=1");
    expect(out).toEqual([
      "#7 open  spore/fix-ui -> main  https://github.com/o/r/pull/7",
      "  Fix UI",
      "Review: review required   Mergeable: conflicts with main",
      "Local commits differ from the PR. Push them: pi-spore pr push <workspace>",
      "2 uncommitted files are not in the PR.",
      "Checks:",
      "  fail      CI / test  https://ci/1",
      "  pending   lint",
      "Watch: waiting for you  tries 3/3",
      "  Stopped after 3 automatic tries in a row. Waiting for you.",
    ]);
  });

  it("says when there is no PR yet, and turns the watch on", async () => {
    const { deps, out, sent } = fakeDeps(() => Response.json(status));
    expect(await run(["pr", "status", "W1"], deps)).toBe(0);
    expect(out).toEqual(["No PR yet. Open one: pi-spore pr open W1"]);
    expect(await run(["pr", "watch", "W1", "on"], deps)).toBe(0);
    expect(sent[1]?.body).toEqual({ on: true });
    expect(await run(["pr", "watch", "W1", "maybe"], deps)).toBe(2);
  });
});

describe("pi-spore pipeline", () => {
  const stages = [
    { name: "implement", role: "worker" },
    { name: "review", role: "reviewer" },
  ];
  const turns = [
    {
      id: "T1",
      runId: "R1",
      stageIndex: 0,
      stage: "implement",
      round: 1,
      kind: "task",
      role: "worker",
      agentId: "A1",
      report: {
        turn: "T1",
        summary: "Built it",
        tests: [{ name: "adds", proof: "proofs/adds.txt" }],
      },
      createdAt: 1,
    },
    {
      id: "T2",
      runId: "R1",
      stageIndex: 1,
      stage: "review",
      round: 1,
      kind: "review",
      role: "reviewer",
      agentId: "A2",
      report: {
        turn: "T2",
        summary: "Needs work",
        verdict: "revise",
        findings: [
          { severity: "minor", title: "Naming" },
          { severity: "blocking", title: "Crash on empty input", file: "src/a.ts", line: 12 },
        ],
        earlyStop: { stop: false, probability: 0.2 },
      },
      createdAt: 2,
    },
  ];
  const pipelineRun = {
    id: "R1",
    workspaceId: "W1",
    pipelineId: "ship",
    source: "user",
    hash: "abc",
    stages,
    brief: "Build it",
    askingAgentId: "A0",
    state: "running",
    stageIndex: 1,
    blocked: "stage review: reviewer model is not stronger",
    tests: [],
    turns,
    createdAt: 1,
  };

  it("lists pipelines, a broken one with its error", async () => {
    const { deps, out, sent } = fakeDeps(() =>
      Response.json({
        pipelines: [
          { id: "ship", source: "user", hash: "abc", stages },
          { id: "bad", source: "project", error: "stage 1: unknown key" },
        ],
      }),
    );
    expect(await run(["pipeline", "list", "W1"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/pipelines/workspaces/W1");
    expect(out).toEqual([
      `${"ship".padEnd(20)} ${"user".padEnd(9)} implement > review`,
      `${"bad".padEnd(20)} ${"project".padEnd(9)} error: stage 1: unknown key`,
    ]);
  });

  it("starts a run from --brief, or from --brief-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-spore-cli-"));
    try {
      const file = join(dir, "brief.md");
      writeFileSync(file, "From a file");
      const { deps, out, sent } = fakeDeps(
        () => Response.json({ run: pipelineRun }, { status: 201 }),
        {
          resolvePath: (path) => path,
        },
      );

      expect(await run(["pipeline", "start", "W1", "ship", "--brief", "Do it"], deps)).toBe(0);
      expect(await run(["pipeline", "start", "W1", "ship", "--brief-file", file], deps)).toBe(0);

      expect(sent.map((request) => request.body)).toEqual([
        { pipeline: "ship", brief: "Do it" },
        { pipeline: "ship", brief: "From a file" },
      ]);
      expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/pipelines/workspaces/W1/runs");
      expect(out[0]).toContain("Started R1  running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs exactly one of --brief and --brief-file, and names an unreadable file", async () => {
    const { deps, err, sent } = fakeDeps(() => Response.json({}));
    expect(await run(["pipeline", "start", "W1", "ship"], deps)).toBe(2);
    expect(
      await run(["pipeline", "start", "W1", "ship", "--brief", "a", "--brief-file", "b"], deps),
    ).toBe(2);
    expect(
      await run(["pipeline", "start", "W1", "ship", "--brief-file", "/nope/brief.md"], deps),
    ).toBe(1);
    expect(err.at(-1)).toContain("/nope/brief.md");
    expect(sent).toEqual([]);
  });

  it("lists runs, one line each, with the stage and why a run is stuck", async () => {
    const { deps, out, sent } = fakeDeps(() => Response.json({ runs: [pipelineRun] }));
    expect(await run(["pipeline", "runs", "W1"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/pipelines/workspaces/W1/runs");
    expect(out).toEqual([
      `R1  ${"running".padEnd(12)} ship  stage review  blocked: stage review: reviewer model is not stronger`,
    ]);
  });

  it("shows stages, turns, verdicts, and findings by severity", async () => {
    const { deps, out, sent } = fakeDeps(() => Response.json({ run: pipelineRun }));
    expect(await run(["pipeline", "show", "R1"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/pipelines/runs/R1");
    const text = out.join("\n");
    expect(text).toContain("Stage review  (current)");
    expect(text).toContain("task round 1  worker  chat A1  reported");
    expect(text).toContain("test: adds  proof proofs/adds.txt");
    expect(text).toContain("review round 1  reviewer  chat A2  revise");
    expect(text.indexOf("blocking: Crash on empty input (src/a.ts:12)")).toBeLessThan(
      text.indexOf("minor: Naming"),
    );
    expect(text).toContain("Jev: go on (20%)");
    expect(text).toContain("Fix it, then: pi-spore pipeline retry R1");
  });

  it("prints the run with --json", async () => {
    const { deps, out } = fakeDeps(() => Response.json({ run: pipelineRun }));
    expect(await run(["pipeline", "show", "R1", "--json"], deps)).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ id: "R1", state: "running" });
  });

  it("cancels and retries a run", async () => {
    const { deps, out, sent } = fakeDeps((key) =>
      Response.json({
        run: { ...pipelineRun, state: key.endsWith("/cancel") ? "stopped" : "running" },
      }),
    );
    expect(await run(["pipeline", "cancel", "R1"], deps)).toBe(0);
    expect(await run(["pipeline", "retry", "R1"], deps)).toBe(0);
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST http://127.0.0.1:7420/api/pipelines/runs/R1/cancel",
      "POST http://127.0.0.1:7420/api/pipelines/runs/R1/retry",
    ]);
    expect(out[0]).toContain("Cancelled R1  stopped");
    expect(out[1]).toContain("Retried R1  running");
  });

  it("shows the server's refusal of a retry", async () => {
    const { deps, err } = fakeDeps(() =>
      Response.json(
        { error: { code: "run_not_waiting", message: "The run has no waiting job to retry" } },
        { status: 409 },
      ),
    );
    expect(await run(["pipeline", "retry", "R1"], deps)).toBe(1);
    expect(err).toEqual(["The run has no waiting job to retry"]);
  });
});

describe("pi-spore run", () => {
  const lane = (more: Record<string, unknown>) => ({
    id: "L1",
    runId: "U1",
    name: "api",
    wave: 1,
    dependsOn: [],
    brief: "briefs/api.md",
    pipeline: "default",
    state: "running",
    createdAt: 3,
    ...more,
  });
  const coordinatedRun = {
    id: "U1",
    projectId: "P1",
    workspaceId: "W9",
    line: "run/big-feature-abc123",
    base: "main",
    gates: ["check", "test"],
    state: "running",
    coordinatorAgentId: "A0",
    createdAt: 2,
    lanes: [
      lane({ id: "L2", name: "ui", wave: 2, state: "waiting" }),
      lane({ workspaceId: "W2", state: "failed", message: "gate check failed\nmore" }),
    ],
    questions: [],
  };
  const answer = (key: string) =>
    key === "GET /api/projects"
      ? Response.json({ projects: [project] })
      : Response.json({ run: coordinatedRun, runs: [coordinatedRun] }, { status: 201 });

  it("starts a run with a base and gates, by project slug", async () => {
    const { deps, out, sent } = fakeDeps(answer);
    expect(
      await run(
        [
          "run",
          "start",
          "game",
          "Big feature",
          "--base",
          "dev",
          "--gate",
          "check",
          "--gate",
          "lint",
        ],
        deps,
      ),
    ).toBe(0);
    expect(sent.at(-1)).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7420/api/runs",
      body: { projectId: "P1", name: "Big feature", base: "dev", gates: ["check", "lint"] },
    });
    expect(out.join("\n")).toContain("Workspace W9");
  });

  it("lists runs of one project", async () => {
    const { deps, out, sent } = fakeDeps(answer);
    expect(await run(["run", "list", "--project", "game"], deps)).toBe(0);
    expect(sent.at(-1)?.url).toBe("http://127.0.0.1:7420/api/runs?projectId=P1");
    expect(out).toEqual(["U1  run/big-feature-abc123  running  2 lanes"]);
  });

  it("shows the lanes with wave, state, and workspace", async () => {
    const { deps, out, sent } = fakeDeps(answer);
    expect(await run(["run", "show", "U1"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/runs/U1");
    const text = out.join("\n");
    expect(out[0]).toBe("Run U1  run/big-feature-abc123  from main  running");
    expect(text).toContain("wave 1  failed    api  workspace W2  gate check failed");
    expect(text).toContain("wave 2  waiting   ui");
  });

  it("cancels a run", async () => {
    const { deps, out, sent } = fakeDeps(answer);
    expect(await run(["run", "cancel", "U1"], deps)).toBe(0);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:7420/api/runs/U1/cancel",
    });
    expect(out).toEqual(["Cancelled run U1  run/big-feature-abc123"]);
  });

  it("prints help and fails on bad usage", async () => {
    const { deps, err, sent } = fakeDeps(answer);
    expect(await run(["run", "start", "game"], deps)).toBe(2);
    expect(await run(["run", "show"], deps)).toBe(2);
    expect(await run(["run", "cancel"], deps)).toBe(2);
    expect(await run(["run", "start", "game", "x", "--gate"], deps)).toBe(2);
    expect(err.at(-1)).toContain("Usage: pi-spore");
    expect(sent).toEqual([]);
  });
});

describe("pi-spore usage calibration", () => {
  const emptyBuckets = Array.from({ length: 10 }, (_, index) => ({
    from: index / 10,
    to: (index + 1) / 10,
    answers: 0,
    localOutcomes: 0,
    passed: 0,
    enough: false,
  }));
  const report = {
    threshold: 0.7,
    heavyThreshold: 0.7,
    explore: 0,
    minSample: 20,
    decisions: 34,
    outcomes: 30,
    buckets: {
      bounded: emptyBuckets,
      explicit: emptyBuckets,
      visual: emptyBuckets,
      foundational: emptyBuckets,
      design: emptyBuckets,
      straightforward: emptyBuckets.map((bucket, index) =>
        index === 0 ? { ...bucket, answers: 3 } : bucket,
      ),
    },
    bars: [
      { bar: 0.1, decisions: 34, wouldGoLocal: 34, localOutcomes: 30, passed: 23, enough: true },
      { bar: 0.9, decisions: 34, wouldGoLocal: 3, localOutcomes: 0, passed: 0, enough: false },
    ],
    rungs: [{ rung: 1, place: "local", decisions: 30, outcomes: 30, passed: 23 }],
    skipped: 0,
  };

  it("prints the summary, each bar with its sample size, and too little data", async () => {
    const { deps, out, sent } = fakeDeps(() => Response.json(report));
    expect(await run(["usage", "calibration"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/usage/calibration");
    expect(out.slice(0, 5)).toEqual([
      "Bar now 0.7. 34 decisions with Jev answers, 30 local outcomes.",
      "Suggested bar: none (no bar has 20 local outcomes with 90% passed)",
      "bar  would go local   passed",
      "0.1  34/34 (100%)     23/30 (77%)",
      "0.9  3/34 (9%)        0/0  too little data",
    ]);
    expect(out).toContain("straightforward");
    expect(out).toContain("  0.0-0.1  answers 3   passed 0/0  too little data");
  });

  it("names the suggested bar when there is one", async () => {
    const { deps, out } = fakeDeps(() => Response.json({ ...report, suggestedBar: 0.3 }));
    expect(await run(["usage", "calibration"], deps)).toBe(0);
    expect(out[1]).toBe("Suggested bar: 0.3");
  });

  it("prints the body with --json", async () => {
    const { deps, out } = fakeDeps(() => Response.json(report));
    expect(await run(["usage", "calibration", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(report);
  });

  it("exits 2 on an unknown usage subcommand", async () => {
    const { deps, err, sent } = fakeDeps(healthy);
    expect(await run(["usage", "tokens"], deps)).toBe(2);
    expect(await run(["usage"], deps)).toBe(2);
    expect(err.at(-1)).toContain("Usage: pi-spore");
    expect(sent).toEqual([]);
  });
});

describe("pi-spore inbox", () => {
  const place = {
    workspace: { id: "W1", name: "Fix UI", projectName: "Game", state: "active" },
    agentId: "A1",
    chat: { id: "A1", title: "Worker", kind: "worker", active: true },
  };
  const inbox = {
    items: [
      {
        kind: "question",
        at: NOW - 5 * 60_000,
        ...place,
        question: {
          id: "Q1",
          agentId: "A1",
          workspaceId: "W1",
          question: "Which palette?",
          choices: ["Dark", "Light"],
          state: "open",
          createdAt: NOW - 5 * 60_000,
        },
      },
      {
        kind: "approval",
        at: NOW - 2 * 3_600_000,
        ...place,
        approval: {
          id: "AP1",
          kind: "card-start",
          agentId: "A1",
          workspaceId: "W1",
          title: "Start card Fix UI",
          reason: "Phase 1 is next",
          subject: { cardId: "C1" },
          state: "open",
          createdAt: NOW - 2 * 3_600_000,
        },
      },
      {
        kind: "dialog",
        at: NOW - 30_000,
        ...place,
        dialog: { id: "dlg-1", method: "confirm", title: "Proceed?", message: "Delete it?" },
      },
      { kind: "failed", at: NOW - 3 * 86_400_000, ...place, error: "boom" },
      { kind: "finished", at: NOW - 90_000, ...place },
    ],
    interrupted: [],
    running: [
      {
        agentId: "A2",
        workspace: place.workspace,
        chat: { ...place.chat, id: "A2" },
        status: "busy",
        since: NOW - 10_000,
      },
    ],
  };
  const serve = () => fakeDeps(() => Response.json(inbox));

  it("lists every kind with its age, place, and deep link", async () => {
    const { deps, out, sent } = serve();
    expect(await run(["inbox", "list"], deps)).toBe(0);
    expect(sent[0]?.url).toBe("http://127.0.0.1:7420/api/attention/inbox");
    expect(out).toEqual([
      "question:Q1  question  5m  Game / Fix UI  #/workspaces/W1/chats/A1",
      "approval:AP1  approval  2h  Game / Fix UI  #/workspaces/W1/chats/A1",
      "dialog:A1:dlg-1  dialog  30s  Game / Fix UI  #/workspaces/W1/chats/A1",
      "failed:A1  failed  3d  Game / Fix UI  #/workspaces/W1/chats/A1",
      "finished:A1  finished  1m  Game / Fix UI  #/workspaces/W1/chats/A1",
      "running:A2  running  10s  Game / Fix UI  #/workspaces/W1/chats/A2",
    ]);
  });

  it("says when nothing needs the user", async () => {
    const { deps, out } = fakeDeps(() =>
      Response.json({ items: [], interrupted: [], running: [] }),
    );
    expect(await run(["inbox", "list"], deps)).toBe(0);
    expect(out).toEqual(["Nothing needs you."]);
  });

  it("prints entries with ids and links as JSON", async () => {
    const { deps, out } = serve();
    expect(await run(["inbox", "list", "--json"], deps)).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject([
      { id: "question:Q1", kind: "question", link: "#/workspaces/W1/chats/A1" },
      { id: "approval:AP1", kind: "approval" },
      { id: "dialog:A1:dlg-1" },
      { id: "failed:A1" },
      { id: "finished:A1" },
      { id: "running:A2", kind: "running" },
    ]);
  });

  it("shows a question's subject and choices", async () => {
    const { deps, out } = serve();
    expect(await run(["inbox", "show", "question:Q1"], deps)).toBe(0);
    expect(out.join("\n")).toContain("question: Which palette?");
    expect(out.join("\n")).toContain("choices: Dark, Light");
  });

  it("shows an approval's reason and subject", async () => {
    const { deps, out } = serve();
    expect(await run(["inbox", "show", "approval:AP1"], deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("title: Start card Fix UI");
    expect(text).toContain("reason: Phase 1 is next");
    expect(text).toContain('subject: {"cardId":"C1"}');
  });

  it("shows a dialog, a failure, and running work", async () => {
    const { deps, out } = serve();
    await run(["inbox", "show", "dialog:A1:dlg-1"], deps);
    await run(["inbox", "show", "failed:A1"], deps);
    await run(["inbox", "show", "running:A2"], deps);
    const text = out.join("\n");
    expect(text).toContain("message: Delete it?");
    expect(text).toContain("error: boom");
    expect(text).toContain("status: busy");
  });

  it("lists and shows a notice, which has no workspace or chat", async () => {
    const notice = {
      kind: "notice",
      source: "github-pr",
      id: "pr-7",
      at: NOW - 60_000,
      title: "PR 7 waits for review",
      detail: "Two checks passed",
      href: "#/projects/P1/prs/7",
    };
    const { deps, out } = fakeDeps(() =>
      Response.json({ items: [notice], interrupted: [], running: [] }),
    );
    expect(await run(["inbox", "list"], deps)).toBe(0);
    expect(await run(["inbox", "show", "notice:github-pr:pr-7"], deps)).toBe(0);
    expect(out).toEqual([
      "notice:github-pr:pr-7  notice  1m  github-pr  #/projects/P1/prs/7",
      "id: notice:github-pr:pr-7",
      "kind: notice",
      "age: 1m",
      "link: #/projects/P1/prs/7",
      "source: github-pr",
      "title: PR 7 waits for review",
      "detail: Two checks passed",
    ]);
  });

  it("shows the prefill and placeholder of input and editor dialogs", async () => {
    const dialog = (id: string, rest: object) => ({
      kind: "dialog",
      at: NOW,
      ...place,
      dialog: { id, ...rest },
    });
    const { deps, out } = fakeDeps(() =>
      Response.json({
        items: [
          dialog("d-in", { method: "input", title: "Name?", placeholder: "Type a name" }),
          dialog("d-ed", { method: "editor", title: "Review", prefill: "Line 1\nLine 2" }),
        ],
        interrupted: [],
        running: [],
      }),
    );
    await run(["inbox", "show", "dialog:A1:d-in"], deps);
    await run(["inbox", "show", "dialog:A1:d-ed"], deps);
    const text = out.join("\n");
    expect(text).toContain("placeholder: Type a name");
    expect(text).toContain("prefill: Line 1\nLine 2");
  });

  it("rejects extra arguments before it contacts the server", async () => {
    const { deps, err, sent } = serve();
    expect(await run(["inbox", "list", "extra"], deps)).toBe(2);
    expect(err[0]).toContain("inbox list takes no arguments");
    expect(sent).toEqual([]);
  });

  it("fails for an id that is not in the inbox", async () => {
    const { deps, err } = serve();
    expect(await run(["inbox", "show", "question:nope"], deps)).toBe(1);
    expect(err[0]).toContain('No inbox item "question:nope"');
  });
});
