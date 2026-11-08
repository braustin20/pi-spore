import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { type AgentEvent, createAgentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import {
  type BoardEvent,
  Card,
  type CardColumn,
  CardDetail,
  CardList,
  Project,
  parse,
  Run,
  StartCardResponse,
  Workspace,
} from "@pi-spore/shared";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Cards, CardsKey, cardBrief, kanbanModule } from "./server.js";

const CardBody = Type.Object({ card: Card });
const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let server: TestServer;
let agents: ReturnType<typeof createAgentsModule>;
let scratch: string;
let record: string;
let cards: Cards;

/** Hands the test the module's interface, as another module would get it. */
const probe: ServerModule = {
  id: "probe",
  requires: ["kanban"],
  core: false,
  setup(host) {
    cards = host.use(CardsKey);
  },
};

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-kanban-")));
  record = join(scratch, "launches.jsonl");
  agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({ provider: "fake", modelId: "orchestrator-1", thinking: "high" }),
    baseEnv: { PATH: process.env.PATH, FAKE_PI_RECORD: record },
    idleStopMs: 60_000,
    startTimeoutMs: 1_000,
  });
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    vcsFolderModule,
    workspacesModule,
    agents,
    actionsModule,
    attentionModule,
    artifactsModule,
    pipelinesModule,
    runsModule,
    kanbanModule,
    probe,
  ]);
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** The `--provider`, `--model`, and `--thinking` values of the chat launches so far. */
const launchModels = () =>
  (existsSync(record) ? readFileSync(record, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { argv } = JSON.parse(line) as { argv: string[] };
      const after = (flag: string) => argv[argv.indexOf(flag) + 1];
      return `${after("--provider")}/${after("--model")} ${after("--thinking")}`;
    });

async function json(response: Response, status = 200): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== status) {
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function errorCode(response: Response, status: number): Promise<string> {
  return ((await json(response, status)) as { error: { code: string } }).error.code;
}

async function addProject(name: string): Promise<Project> {
  const path = join(scratch, name);
  mkdirSync(path);
  const body = await json(await server.request("POST", "/api/projects", { path }), 201);
  return parse(Type.Object({ project: Project }), body, "project").project;
}

async function addCard(request: Record<string, unknown>): Promise<Card> {
  const body = await json(await server.request("POST", "/api/kanban/cards", request), 201);
  return parse(CardBody, body, "card").card;
}

async function cardCall(method: string, path: string, body?: unknown): Promise<Card> {
  return parse(
    CardBody,
    await json(await server.request(method, `/api/kanban/cards/${path}`, body)),
    path,
  ).card;
}

const getCard = async (id: string) =>
  parse(CardDetail, await json(await server.request("GET", `/api/kanban/cards/${id}`)), "detail");

async function list(query = ""): Promise<Card[]> {
  return parse(
    CardList,
    await json(await server.request("GET", `/api/kanban/cards${query}`)),
    "list",
  ).cards;
}

/** Titles per column, in board order. */
async function board(): Promise<Partial<Record<CardColumn, string[]>>> {
  const columns: Partial<Record<CardColumn, string[]>> = {};
  for (const card of await list())
    columns[card.column] = [...(columns[card.column] ?? []), card.title];
  return columns;
}

/** Starts work from a card and waits until its worker chat got the brief, so no delivery outlives the test. */
async function startCard(id: string, request: Record<string, unknown>) {
  const result = parse(
    StartCardResponse,
    await json(await server.request("POST", `/api/kanban/cards/${id}/start`, request), 201),
    "start",
  );
  await until(() =>
    userMessages(result.chatId).some((text) => text.includes(`(card ${result.card.id})`)),
  );
  return result;
}

async function addWorkspace(projectId: string, name: string): Promise<Workspace> {
  const body = await json(
    await server.request("POST", "/api/workspaces", { projectId, name, isolation: "in-place" }),
    201,
  );
  return parse(Type.Object({ workspace: Workspace }), body, "workspace").workspace;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The user messages an agent got, as seen live. */
const userMessages = (agentId: string) =>
  (server.events.eventsOf(`agent:${agentId}`) as AgentEvent[]).flatMap((event) => {
    const pi =
      event.type === "pi"
        ? (event.event as { type: string; message?: { role: string; content: unknown } })
        : undefined;
    if (pi?.type !== "message_end" || pi.message?.role !== "user") return [];
    return [String(pi.message.content)];
  });

async function workspaceStep(id: string, step: "park" | "resume" | "archive") {
  return parse(
    Type.Object({ workspace: Workspace }),
    await json(await server.request("POST", `/api/workspaces/${id}/${step}`)),
    step,
  ).workspace;
}

describe("cards", () => {
  it("creates, lists, filters, and updates cards", async () => {
    const game = await addProject("game");
    const first = await addCard({
      title: "  Fix crafting UI ",
      body: "# Steps\n- one",
      projectId: game.id,
      labels: ["ui", " ui", "bug", " "],
      due: "2026-11-10",
    });
    expect(first).toMatchObject({
      title: "Fix crafting UI",
      body: "# Steps\n- one",
      projectId: game.id,
      labels: ["ui", "bug"],
      due: "2026-11-10",
      column: "backlog",
      position: 0,
      blockedBy: [],
      blocked: false,
    });
    await addCard({ title: "Write notes", column: "ready", labels: ["docs"] });
    await addCard({ title: "Second in backlog" });

    expect(await board()).toEqual({
      backlog: ["Fix crafting UI", "Second in backlog"],
      ready: ["Write notes"],
    });
    expect((await list(`?projectId=${game.id}`)).map((card) => card.title)).toEqual([
      "Fix crafting UI",
    ]);
    expect((await list("?label=docs")).map((card) => card.title)).toEqual(["Write notes"]);

    const updated = await cardCall("PATCH", first.id, {
      title: "Fix the crafting UI",
      projectId: null,
      due: null,
      labels: [],
    });
    expect(updated.title).toBe("Fix the crafting UI");
    expect(updated.projectId).toBeUndefined();
    expect(updated.due).toBeUndefined();
    expect(updated.labels).toEqual([]);
    expect(updated.body).toBe("# Steps\n- one");
  });

  it("rejects bad input with clear errors", async () => {
    const post = (body: unknown) => server.request("POST", "/api/kanban/cards", body);
    expect(await errorCode(await post({ title: "" }), 400)).toBe("invalid_request");
    expect(await errorCode(await post({ title: "x", due: "2026-02-30" }), 400)).toBe("bad_due");
    expect(await errorCode(await post({ title: "x", column: "later" }), 400)).toBe(
      "invalid_request",
    );
    expect(await errorCode(await post({ title: "x", projectId: "nope" }), 404)).toBe(
      "project_not_found",
    );
    expect(
      await errorCode(await post({ title: "x", blockedBy: [{ kind: "card", id: "nope" }] }), 404),
    ).toBe("card_not_found");
    const broken = await server.request("POST", "/api/kanban/cards", "{", {
      "content-type": "application/json",
    });
    expect(broken.status).toBe(400);
    expect(await errorCode(await server.request("GET", "/api/kanban/cards/nope"), 404)).toBe(
      "card_not_found",
    );
  });

  it("moves and reorders cards and keeps the history of column moves", async () => {
    const a = await addCard({ title: "A" });
    await addCard({ title: "B" });
    const c = await addCard({ title: "C" });

    await cardCall("POST", `${c.id}/move`, { column: "backlog", index: 1 });
    expect(await board()).toEqual({ backlog: ["A", "C", "B"] });

    await cardCall("POST", `${a.id}/move`, { column: "ready" });
    const moved = await cardCall("POST", `${a.id}/move`, { column: "review", index: 9 });
    expect(moved.position).toBe(0);
    expect(await board()).toEqual({ backlog: ["C", "B"], review: ["A"] });
    expect((await list()).map((card) => [card.title, card.position])).toEqual([
      ["C", 0],
      ["B", 1],
      ["A", 0],
    ]);

    const { history } = await getCard(a.id);
    expect(history.map((move) => [move.from, move.to, move.reason])).toEqual([
      [undefined, "backlog", "created"],
      ["backlog", "ready", "manual"],
      ["ready", "review", "manual"],
    ]);
  });

  it("deletes a card, its links, and the gap it leaves", async () => {
    const a = await addCard({ title: "A" });
    const b = await addCard({ title: "B" });
    const c = await addCard({ title: "C", blockedBy: [{ kind: "card", id: a.id }] });
    expect(c.blocked).toBe(true);

    await json(await server.request("DELETE", `/api/kanban/cards/${a.id}`));
    expect(await board()).toEqual({ backlog: ["B", "C"] });
    expect((await list()).map((card) => card.position)).toEqual([0, 1]);
    expect((await getCard(c.id)).card).toMatchObject({ blockedBy: [], blocked: false });
    expect((await getCard(b.id)).card.blocked).toBe(false);
  });
});

describe("blockers", () => {
  it("shows card and workspace blockers and clears them when the work ends", async () => {
    const game = await addProject("game");
    const ws = await json(
      await server.request("POST", "/api/workspaces", {
        projectId: game.id,
        name: "Prep",
        isolation: "in-place",
      }),
      201,
    );
    const prepId = (ws as { workspace: Workspace }).workspace.id;
    const first = await addCard({ title: "First" });
    const later = await addCard({
      title: "Later",
      blockedBy: [
        { kind: "card", id: first.id },
        { kind: "workspace", id: prepId },
        { kind: "card", id: first.id },
      ],
    });
    expect(later.blockedBy).toEqual([
      { kind: "card", id: first.id, title: "First", column: "backlog", open: true },
      { kind: "workspace", id: prepId, name: "Prep", state: "active", open: true },
    ]);
    expect(later.blocked).toBe(true);

    await cardCall("POST", `${first.id}/move`, { column: "done" });
    expect((await getCard(later.id)).card.blocked).toBe(true);
    await workspaceStep(prepId, "archive");
    const cleared = (await getCard(later.id)).card;
    expect(cleared.blocked).toBe(false);
    expect(cleared.blockedBy.map((blocker) => blocker.open)).toEqual([false, false]);

    expect(
      await errorCode(
        await server.request("PATCH", `/api/kanban/cards/${later.id}`, {
          blockedBy: [{ kind: "card", id: later.id }],
        }),
        422,
      ),
    ).toBe("self_blocker");
    expect((await cardCall("PATCH", later.id, { blockedBy: [] })).blockedBy).toEqual([]);
  });
});

describe("starting work from a card", () => {
  it("starts a workspace named after the card, links it, and moves the card to In progress", async () => {
    const game = await addProject("game");
    const card = await addCard({ title: "Fix crafting UI", column: "ready" });

    expect(
      await errorCode(
        await server.request("POST", `/api/kanban/cards/${card.id}/start`, {
          isolation: "in-place",
        }),
        400,
      ),
    ).toBe("project_required");

    const result = await startCard(card.id, { projectId: game.id, isolation: "in-place" });
    expect(result.created?.workspace).toEqual(result.workspace);
    expect(result.workspace).toMatchObject({ name: "Fix crafting UI", state: "active" });
    expect(result.card).toMatchObject({
      column: "in-progress",
      projectId: game.id,
      workspaceId: result.workspace.id,
    });
    expect(cards.forWorkspace(result.workspace.id).map((found) => found.id)).toEqual([card.id]);
    expect((await list(`?workspaceId=${result.workspace.id}`)).map((found) => found.id)).toEqual([
      card.id,
    ]);
    // ADR 0100: the new workspace's worker chat gets the brief, so the work starts.
    const brief = cardBrief(result.card, "The user started it here.");
    await until(() => userMessages(result.chatId).includes(brief));
    expect((await getCard(card.id)).history.at(-1)).toMatchObject({
      from: "ready",
      to: "in-progress",
      reason: "workspace-started",
    });

    expect(
      await errorCode(
        await server.request("POST", `/api/kanban/cards/${card.id}/start`, {
          isolation: "in-place",
        }),
        409,
      ),
    ).toBe("card_has_workspace");
  });

  it("asks before it starts a blocked card", async () => {
    const game = await addProject("game");
    const blocker = await addCard({ title: "Design first" });
    const card = await addCard({
      title: "Build it",
      projectId: game.id,
      blockedBy: [{ kind: "card", id: blocker.id }],
    });
    const refused = await server.request("POST", `/api/kanban/cards/${card.id}/start`, {
      isolation: "in-place",
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "card_blocked",
      message: "This card is blocked by: Design first",
    });
    const workspaces = await json(await server.request("GET", "/api/workspaces"));
    expect((workspaces as { workspaces: unknown[] }).workspaces).toEqual([]);

    const result = await startCard(card.id, { isolation: "in-place", confirmBlocked: true });
    expect(result.card.column).toBe("in-progress");

    const other = await addProject("other");
    const second = await addCard({ title: "Elsewhere", projectId: game.id });
    expect(
      await errorCode(
        await server.request("POST", `/api/kanban/cards/${second.id}/start`, {
          projectId: other.id,
          isolation: "in-place",
        }),
        422,
      ),
    ).toBe("project_mismatch");
  });
});

/** A git project on `main` with one commit, so it supports runs. */
async function addGitProject(name: string): Promise<Project> {
  const path = join(scratch, name);
  mkdirSync(path);
  writeFileSync(join(path, "a.txt"), "one\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["commit", "-q", "-m", "base"],
  ]) {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: path });
  }
  const body = await json(await server.request("POST", "/api/projects", { path }), 201);
  return parse(Type.Object({ project: Project }), body, "project").project;
}

const RunStart = Type.Intersect([StartCardResponse, Type.Object({ run: Run })]);
const startRun = async (id: string, request: Record<string, unknown> = {}) =>
  parse(
    RunStart,
    await json(
      await server.request("POST", `/api/kanban/cards/${id}/start`, { run: true, ...request }),
      201,
    ),
    "start",
  );

describe("starting a run from a card", () => {
  it("creates the run, links its workspace, moves the card, and briefs the coordinator", async () => {
    const game = await addGitProject("game");
    const card = await addCard({ title: "Build crafting", column: "ready", projectId: game.id });

    const result = await startRun(card.id);
    const runs = (await json(await server.request("GET", `/api/runs?projectId=${game.id}`))) as {
      runs: Run[];
    };
    expect(runs.runs.map((run) => run.id)).toEqual([result.run.id]);
    expect(result.card).toMatchObject({
      column: "in-progress",
      workspaceId: result.run.workspaceId,
    });
    expect(result.workspace.id).toBe(result.run.workspaceId);
    expect(result.chatId).toBe(result.run.coordinatorAgentId);
    const brief = cardBrief(result.card, "The user started it here.");
    await until(() => userMessages(result.chatId).includes(brief));
    expect((await getCard(card.id)).history.at(-1)).toMatchObject({
      from: "ready",
      to: "in-progress",
      reason: "run-started",
    });
  });

  it("moves the card to Review on a PR and to Done when the run workspace is archived", async () => {
    const game = await addGitProject("game");
    const card = await addCard({ title: "Build crafting", projectId: game.id });
    const { run, chatId } = await startRun(card.id);
    await until(() => userMessages(chatId).some((text) => text.includes(`(card ${card.id})`)));

    cards.workChanged(run.workspaceId, "review", "pr-opened");
    expect((await getCard(card.id)).card.column).toBe("review");

    await workspaceStep(run.workspaceId, "archive");
    expect((await getCard(card.id)).card.column).toBe("done");
  });

  it("refuses a project without runs and leaves the card where it was", async () => {
    const folder = await addProject("folder");
    const card = await addCard({ title: "Nope", column: "ready", projectId: folder.id });
    expect(
      await errorCode(
        await server.request("POST", `/api/kanban/cards/${card.id}/start`, { run: true }),
        422,
      ),
    ).toBe("not_supported");
    expect((await getCard(card.id)).card).toMatchObject({ column: "ready" });
    expect((await getCard(card.id)).card.workspaceId).toBeUndefined();
  });

  it("starts the coordinator chat on the model of the request", async () => {
    const game = await addGitProject("game");
    const card = await addCard({ title: "Use mine", projectId: game.id, model: "fake/card-model" });
    const { chatId } = await startRun(card.id, { model: "fake/start-model" });
    await until(() => userMessages(chatId).some((text) => text.includes(`(card ${card.id})`)));
    expect(launchModels()).toEqual(["fake/start-model high"]);
  });
});

describe("the model of a new chat (ADR 0120)", () => {
  it("stores a card's model, checks its shape, and clears it", async () => {
    const card = await addCard({ title: "Pick a model", model: "fake/card-model" });
    expect(card.model).toBe("fake/card-model");
    expect((await cardCall("PATCH", card.id, { title: "Renamed" })).model).toBe("fake/card-model");
    expect((await cardCall("PATCH", card.id, { model: "fake/other" })).model).toBe("fake/other");
    expect((await cardCall("PATCH", card.id, { model: null })).model).toBeUndefined();
    for (const model of ["no-slash", "/id", "provider/", "a b/c"]) {
      expect(
        (await server.request("PATCH", `/api/kanban/cards/${card.id}`, { model })).status,
      ).toBe(400);
    }
    expect(
      (await server.request("POST", "/api/kanban/cards", { title: "x", model: "x" })).status,
    ).toBe(400);
  });

  it("starts the chat on the card's model, with the thinking of the role", async () => {
    const game = await addProject("game");
    const card = await addCard({ title: "Use mine", projectId: game.id, model: "fake/card-model" });
    await startCard(card.id, { isolation: "in-place" });
    expect(launchModels()).toEqual(["fake/card-model high"]);
  });

  it("prefers the model of the start over the card's", async () => {
    const game = await addProject("game");
    const card = await addCard({ title: "Use mine", projectId: game.id, model: "fake/card-model" });
    await startCard(card.id, { isolation: "in-place", model: "fake/start-model" });
    expect(launchModels()).toEqual(["fake/start-model high"]);
  });

  it("uses the orchestrator default when neither names a model", async () => {
    const game = await addProject("game");
    const card = await addCard({ title: "Default", projectId: game.id });
    await startCard(card.id, { isolation: "in-place" });
    expect(launchModels()).toEqual(["fake/orchestrator-1 high"]);
  });

  it("refuses a model for an existing workspace and starts nothing", async () => {
    const game = await addProject("game");
    const workspace = await addWorkspace(game.id, "Crafting");
    const card = await addCard({ title: "Too late", projectId: game.id });
    const response = await server.request("POST", `/api/kanban/cards/${card.id}/start`, {
      workspaceId: workspace.id,
      model: "fake/start-model",
    });
    expect(await errorCode(response, 400)).toBe("model_needs_new_workspace");
    expect((await getCard(card.id)).card).toMatchObject({ column: "backlog" });
  });

  it("starts an approved card on the model the user changed it to", async () => {
    const game = await addProject("game");
    const asking = await addWorkspace(game.id, "Planner");
    const { agent } = parse(
      Type.Object({ agent: Type.Object({ id: Type.String() }) }),
      await json(await server.request("POST", "/api/agents", { workspaceId: asking.id }), 201),
      "agent",
    );
    const card = await addCard({
      title: "Approve me",
      projectId: game.id,
      model: "fake/card-model",
    });
    const target = { kind: "new", isolation: "in-place" };
    const approval = cards.requestStart({ agentId: agent.id, workspaceId: asking.id }, card.id, {
      target: { kind: "new", isolation: "in-place" },
      reason: "Next",
    });

    await json(
      await server.request("POST", `/api/attention/approvals/${approval.id}/approve`, {
        subject: { cardId: card.id, target, model: "fake/changed-model" },
      }),
    );
    // Wait for both deliveries (the brief and the decision) so none outlives the test.
    await until(
      async () =>
        userMessages(agent.id).some((text) => text.includes("approved your request")) &&
        launchModels().includes("fake/changed-model high"),
    );
    expect(launchModels()).not.toContain("fake/card-model high");
  });

  it("re-checks the model of a changed approval", async () => {
    const game = await addProject("game");
    const asking = await addWorkspace(game.id, "Planner");
    const { agent } = parse(
      Type.Object({ agent: Type.Object({ id: Type.String() }) }),
      await json(await server.request("POST", "/api/agents", { workspaceId: asking.id }), 201),
      "agent",
    );
    const card = await addCard({ title: "Approve me", projectId: game.id });
    const approval = cards.requestStart({ agentId: agent.id, workspaceId: asking.id }, card.id, {
      target: { kind: "new", isolation: "in-place" },
      reason: "Next",
    });
    const response = await server.request(
      "POST",
      `/api/attention/approvals/${approval.id}/approve`,
      {
        subject: { cardId: card.id, target: { kind: "new", isolation: "in-place" }, model: "bad" },
      },
    );
    expect(response.status).toBe(400);
  });
});

describe("starting work in an existing workspace", () => {
  it("links the card, moves it, and sends the brief to the active worker chat", async () => {
    const game = await addProject("game");
    const workspace = await addWorkspace(game.id, "Crafting");
    const { agent } = parse(
      Type.Object({ agent: Type.Object({ id: Type.String() }) }),
      await json(await server.request("POST", "/api/agents", { workspaceId: workspace.id }), 201),
      "agent",
    );
    const blocker = await addCard({ title: "Design first", projectId: game.id, column: "done" });
    const card = await addCard({
      title: "Polish the crafting UI",
      body: "Make the buttons bigger.",
      projectId: game.id,
      labels: ["plan:craft"],
      blockedBy: [{ kind: "card", id: blocker.id }],
    });

    const result = await startCard(card.id, { workspaceId: workspace.id });
    expect(result.created).toBeUndefined();
    expect(result.chatId).toBe(agent.id);
    expect(result.card).toMatchObject({ column: "in-progress", workspaceId: workspace.id });
    const brief = cardBrief(result.card, "The user started it here.");
    expect(brief).toBe(
      [
        "Work on this card from the pi-spore board. The user started it here.",
        "",
        `Card: Polish the crafting UI (card ${card.id})`,
        "Labels: plan:craft",
        "Blocked by:",
        `- card "Design first" (${blocker.id}), Done`,
        "",
        "Make the buttons bigger.",
      ].join("\n"),
    );
    await until(() => userMessages(agent.id).includes(brief));
    expect((await getCard(card.id)).history.at(-1)).toMatchObject({
      to: "in-progress",
      reason: "workspace-started",
    });
  });

  it("queues the brief as a follow-up when the worker is busy", async () => {
    const game = await addProject("game");
    const workspace = await addWorkspace(game.id, "Busy");
    const { agent } = parse(
      Type.Object({ agent: Type.Object({ id: Type.String() }) }),
      await json(await server.request("POST", "/api/agents", { workspaceId: workspace.id }), 201),
      "agent",
    );
    await json(
      await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: "slow:300" }),
    );
    await until(() => agents.manager().view(agent.id).status === "busy");
    const card = await addCard({ title: "Next thing", projectId: game.id });
    const result = parse(
      StartCardResponse,
      await json(
        await server.request("POST", `/api/kanban/cards/${card.id}/start`, {
          workspaceId: workspace.id,
        }),
        201,
      ),
      "start",
    );
    const brief = cardBrief(result.card, "The user started it here.");
    // The busy run is not cut off: the brief waits in Pi's follow-up queue, not as a steer.
    const queued = () =>
      (server.events.eventsOf(`agent:${agent.id}`) as AgentEvent[]).flatMap((event) => {
        const pi =
          event.type === "pi"
            ? (event.event as { type: string; steering?: string[]; followUp?: string[] })
            : undefined;
        return pi?.type === "queue_update" ? [pi] : [];
      });
    await until(() => queued().some((update) => update.followUp?.includes(brief)));
    expect(queued().every((update) => (update.steering ?? []).length === 0)).toBe(true);
  });

  it("creates the worker chat when the workspace has none", async () => {
    const game = await addProject("game");
    const workspace = await addWorkspace(game.id, "Empty");
    const card = await addCard({ title: "Start here", projectId: game.id });
    const result = await startCard(card.id, { workspaceId: workspace.id });
    expect(agents.manager().view(result.chatId)).toMatchObject({
      workspaceId: workspace.id,
      kind: "worker",
      active: true,
    });
  });

  it("refuses a parked workspace and another project's workspace", async () => {
    const game = await addProject("game");
    const other = await addProject("other");
    const parked = await addWorkspace(game.id, "Parked");
    await workspaceStep(parked.id, "park");
    const elsewhere = await addWorkspace(other.id, "Elsewhere");
    const card = await addCard({ title: "Somewhere", projectId: game.id });
    const start = (workspaceId: string) =>
      server.request("POST", `/api/kanban/cards/${card.id}/start`, { workspaceId });
    expect(await errorCode(await start(parked.id), 409)).toBe("workspace_not_active");
    expect(await errorCode(await start(elsewhere.id), 422)).toBe("project_mismatch");
    expect(await errorCode(await start("nope"), 404)).toBe("workspace_not_found");
    expect((await getCard(card.id)).card).toMatchObject({ column: "backlog" });
    expect((await getCard(card.id)).card.workspaceId).toBeUndefined();
  });
});

describe("automatic moves", () => {
  it("moves the card to Done on archive, and a manual move wins until the next change", async () => {
    const game = await addProject("game");
    const card = await addCard({ title: "Ship it", projectId: game.id });
    const { workspace } = await startCard(card.id, { isolation: "in-place" });
    const workspaceId = workspace.id;

    // A manual move stays through changes that do not move cards.
    await cardCall("POST", `${card.id}/move`, { column: "review" });
    await workspaceStep(workspaceId, "park");
    await workspaceStep(workspaceId, "resume");
    expect((await getCard(card.id)).card.column).toBe("review");

    await workspaceStep(workspaceId, "archive");
    const { card: done, history } = await getCard(card.id);
    expect(done.column).toBe("done");
    expect(history.at(-1)).toMatchObject({
      from: "review",
      to: "done",
      reason: "workspace-archived",
    });

    await cardCall("POST", `${card.id}/move`, { column: "backlog" });
    expect((await getCard(card.id)).card.column).toBe("backlog");
  });

  it("clears the archived mark when a card leaves Done", async () => {
    const card = await addCard({ title: "Old work", column: "done" });
    server.store.run("UPDATE kanban_cards SET archived_at = ? WHERE id = ?", 5, card.id);
    expect((await getCard(card.id)).card.archivedAt).toBe(5);

    await cardCall("POST", `${card.id}/move`, { column: "ready" });
    const { card: moved } = await getCard(card.id);
    expect(moved.column).toBe("ready");
    expect(moved.archivedAt).toBeUndefined();
  });

  it("lets other modules move the cards of a workspace", async () => {
    const game = await addProject("game");
    const card = await addCard({ title: "Review me", projectId: game.id });
    const { workspace } = await startCard(card.id, { isolation: "in-place" });

    cards.workChanged(workspace.id, "review", "pipeline-passed");
    cards.workChanged(workspace.id, "review", "pr-opened");
    const { card: moved, history } = await getCard(card.id);
    expect(moved.column).toBe("review");
    expect(history.map((move) => move.reason)).toEqual([
      "created",
      "workspace-started",
      "pipeline-passed",
    ]);
  });
});

describe("live board", () => {
  it("sends the board on subscribe and after every change", async () => {
    const [snapshot] = (await server.events.snapshot("kanban:board")) as BoardEvent[];
    expect(snapshot).toEqual({ type: "board", cards: [] });

    const card = await addCard({ title: "Live" });
    await cardCall("POST", `${card.id}/move`, { column: "ready" });
    const events = server.events.eventsOf("kanban:board") as BoardEvent[];
    expect(events.map((event) => event.cards.map((found) => found.column))).toEqual([
      ["backlog"],
      ["ready"],
    ]);
  });
});
