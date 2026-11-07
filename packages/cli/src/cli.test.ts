import { describe, expect, it } from "vitest";
import { type CliDeps, run } from "./cli.js";

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

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
  role: "worker",
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
