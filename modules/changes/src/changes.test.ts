import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentEvent, createAgentsModule } from "@pi-spore/mod-agents/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type {
  ChangedFileList,
  ChangesEvent,
  ChangesSummary,
  DiffComment,
  DiffList,
  Workspace,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_PNG } from "../../agents/test-fixtures/png.mjs";
import { CHANGES_TOPIC, createChangesModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let server: TestServer;
let scratch: string;
let agents: ReturnType<typeof createAgentsModule>;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-changes-")));
  agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 5_000,
  });
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    vcsFolderModule,
    workspacesModule,
    agents,
    createChangesModule({ maxDiffFiles: 2 }),
  ]);
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function errorCode(response: Response, status: number): Promise<string> {
  const body = await json<{ error: { code: string } }>(response, status);
  return body.error.code;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A Git project with one commit and a workspace on a new branch from main. */
async function gitWorkspace(): Promise<Workspace> {
  const repo = join(scratch, "game");
  git(scratch, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: repo }),
    201,
  );
  const { workspace } = await json<{ workspace: Workspace }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "Fix it",
      isolation: "new",
    }),
    201,
  );
  return workspace;
}

const get = <T>(path: string) =>
  server.request("GET", `/api/changes/${path}`).then((r) => json<T>(r));

/** What the fake agent said, as seen live. */
const said = (agentId: string) =>
  (server.events.eventsOf(`agent:${agentId}`) as AgentEvent[]).flatMap((event) => {
    const pi =
      event.type === "pi"
        ? (event.event as { type: string; message?: { role: string; content: unknown } })
        : undefined;
    if (pi?.type !== "message_end" || !pi.message || pi.message.role !== "user") return [];
    const { content } = pi.message;
    return [
      typeof content === "string"
        ? content
        : (content as { text?: string }[]).map((block) => block.text).join(""),
    ];
  });

describe("changes", () => {
  it("shows uncommitted, staged, branch, and one-commit changes of a workspace", async () => {
    const workspace = await gitWorkspace();
    writeFileSync(join(workspace.path, "a.txt"), "one\nTWO\n");
    git(workspace.path, "commit", "-q", "-am", "edit a");
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    git(workspace.path, "add", "b.txt");
    writeFileSync(join(workspace.path, "c.txt"), "c\n");

    const summary = await get<ChangesSummary>(`workspaces/${workspace.id}`);
    expect(summary).toMatchObject({
      scopes: ["uncommitted", "staged", "line", "record"],
      base: "main",
      records: [{ subject: "edit a" }],
    });
    const paths = async (query: string) =>
      (await get<ChangedFileList>(`workspaces/${workspace.id}/files?${query}`)).files.map(
        (file) => `${file.status} ${file.path} +${file.additions} -${file.deletions}`,
      );
    expect(await paths("")).toEqual(["added b.txt +1 -0", "added c.txt +1 -0"]);
    expect(await paths("scope=staged")).toEqual(["added b.txt +1 -0"]);
    expect(await paths("scope=line")).toEqual(["modified a.txt +1 -1"]);
    expect(await paths(`scope=record&record=${summary.records[0]?.id}`)).toEqual([
      "modified a.txt +1 -1",
    ]);

    const { diffs } = await get<DiffList>(`workspaces/${workspace.id}/diff?scope=line&path=a.txt`);
    expect(diffs[0]?.hunks[0]?.lines.map((line) => `${line.kind} ${line.text}`)).toEqual([
      "context one",
      "del two",
      "add TWO",
    ]);
  });

  it("answers a diff without a path for every file up to the limit, and says when it cut", async () => {
    const workspace = await gitWorkspace();
    for (const name of ["x", "y", "z"]) writeFileSync(join(workspace.path, name), `${name}\n`);
    const all = await get<DiffList>(`workspaces/${workspace.id}/diff`);
    expect(all.diffs.map((diff) => diff.file.path)).toEqual(["x", "y"]);
    expect(all.truncated).toBe(true);
  });

  it("refuses bad scopes, a path without changes, and folder projects", async () => {
    const workspace = await gitWorkspace();
    writeFileSync(join(workspace.path, "changed.txt"), "x\n");
    expect(
      await errorCode(
        await server.request("GET", `/api/changes/workspaces/${workspace.id}/files?scope=all`),
        400,
      ),
    ).toBeTruthy();
    expect(
      await errorCode(
        await server.request("GET", `/api/changes/workspaces/${workspace.id}/files?scope=record`),
        400,
      ),
    ).toBe("record_required");
    expect(
      await errorCode(
        await server.request(
          "GET",
          `/api/changes/workspaces/${workspace.id}/diff?path=../etc/passwd`,
        ),
        404,
      ),
    ).toBe("file_not_changed");

    const folder = join(scratch, "plain");
    mkdirSync(folder);
    const { project } = await json<{ project: { id: string } }>(
      await server.request("POST", "/api/projects", { path: folder }),
      201,
    );
    const { workspace: plain } = await json<{ workspace: Workspace }>(
      await server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "plain",
        isolation: "in-place",
      }),
      201,
    );
    expect(
      await errorCode(await server.request("GET", `/api/changes/workspaces/${plain.id}`), 422),
    ).toBe("not_supported");
  });

  it("tells open tabs to refresh when the worker's run ends", async () => {
    const workspace = await gitWorkspace();
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    await json(await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: "hi" }));
    await until(() =>
      (server.events.eventsOf(`${CHANGES_TOPIC}${workspace.id}`) as ChangesEvent[]).some(
        (event) => event.type === "stale",
      ),
    );
  });
});

describe("diff comments", () => {
  const comment = (workspaceId: string, body: Record<string, unknown>) =>
    server.request("POST", `/api/changes/workspaces/${workspaceId}/comments`, body);

  it("collect in a list and go to the active worker chat as one message", async () => {
    const workspace = await gitWorkspace();
    const first = await json<{ comment: DiffComment }>(
      await comment(workspace.id, {
        path: "a.txt",
        side: "new",
        line: 2,
        code: "TWO",
        body: "Keep this lowercase.",
      }),
      201,
    );
    await json(
      await comment(workspace.id, {
        path: "src/old.ts",
        side: "old",
        line: 7,
        code: "const x = 1;",
        body: "Why remove this?\nIt is used.",
      }),
      201,
    );
    const [snapshot] = (await server.events.snapshot(
      `${CHANGES_TOPIC}${workspace.id}`,
    )) as ChangesEvent[];
    expect(snapshot).toMatchObject({
      type: "comments",
      comments: [{ body: "Keep this lowercase." }, {}],
    });

    const noWorker = await server.request(
      "POST",
      `/api/changes/workspaces/${workspace.id}/comments/send`,
    );
    expect(await errorCode(noWorker, 409)).toBe("no_worker_chat");

    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    const sent = await json<{ agentId: string; comments: DiffComment[] }>(
      await server.request("POST", `/api/changes/workspaces/${workspace.id}/comments/send`),
    );
    expect(sent.agentId).toBe(agent.id);
    expect(sent.comments.map((item) => item.id)[0]).toBe(first.comment.id);
    expect(
      (await get<{ comments: DiffComment[] }>(`workspaces/${workspace.id}/comments`)).comments,
    ).toEqual([]);

    await until(() => said(agent.id).length > 0);
    expect(said(agent.id)).toEqual([
      [
        "Review comments on your changes. Address each one.",
        "",
        "1. `a.txt` line 2:",
        "   > TWO",
        "   Keep this lowercase.",
        "",
        "2. `src/old.ts` line 7 (a removed line, old numbering):",
        "   > const x = 1;",
        "   Why remove this?",
        "   It is used.",
      ].join("\n"),
    ]);
    expect(
      await errorCode(
        await server.request("POST", `/api/changes/workspaces/${workspace.id}/comments/send`),
        409,
      ),
    ).toBe("no_comments");
  });

  it("can be deleted before they are sent, and refuse an empty body", async () => {
    const workspace = await gitWorkspace();
    const { comment: made } = await json<{ comment: DiffComment }>(
      await comment(workspace.id, { path: "a.txt", side: "new", line: 1, code: "one", body: "x" }),
      201,
    );
    expect(
      await errorCode(
        await comment(workspace.id, { path: "a.txt", side: "new", line: 1, code: "", body: "  " }),
        400,
      ),
    ).toBe("empty_comment");
    await json(await server.request("DELETE", `/api/changes/comments/${made.id}`));
    expect(
      (await get<{ comments: DiffComment[] }>(`workspaces/${workspace.id}/comments`)).comments,
    ).toEqual([]);
    expect(
      await errorCode(await server.request("DELETE", `/api/changes/comments/${made.id}`), 404),
    ).toBe("comment_not_found");
  });
});

describe("staged comments", () => {
  const comment = async (workspaceId: string, line: number) =>
    (
      await json<{ comment: DiffComment }>(
        await server.request("POST", `/api/changes/workspaces/${workspaceId}/comments`, {
          path: "a.txt",
          side: "new",
          line,
          code: `code ${line}`,
          body: `Fix line ${line}.`,
        }),
        201,
      )
    ).comment;
  const stage = (workspaceId: string, body: Record<string, unknown>) =>
    server.request("POST", `/api/changes/workspaces/${workspaceId}/comments/stage`, body);
  const open = async (workspaceId: string) =>
    (await get<{ comments: DiffComment[] }>(`workspaces/${workspaceId}/comments`)).comments;

  it("go with the next message of the chat, in one message, and are marked sent", async () => {
    const workspace = await gitWorkspace();
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    for (const line of [1, 2, 3]) await comment(workspace.id, line);
    await json(await stage(workspace.id, { staged: true }));
    expect((await open(workspace.id)).map((item) => item.staged)).toEqual([true, true, true]);

    await json(
      await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: "Go on" }),
    );
    await until(() => said(agent.id).length > 0);
    const messages = said(agent.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Go on");
    for (const line of [1, 2, 3]) {
      expect(messages[0]).toContain(
        `\`a.txt\` line ${line}:\n   > code ${line}\n   Fix line ${line}.`,
      );
    }
    expect(await open(workspace.id)).toEqual([]);

    // Wait for the first turn to end, or "Again" goes in as a steer the fake agent never runs.
    const statuses = () =>
      (server.events.eventsOf(`agent:${agent.id}`) as AgentEvent[]).flatMap((event) =>
        event.type === "status" ? [event.status] : [],
      );
    await until(() => statuses().includes("busy") && statuses().at(-1) === "idle");
    await json(
      await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: "Again" }),
    );
    await until(() => said(agent.id).length > 1);
    expect(said(agent.id)[1]).toBe("Again");
  });

  it("leave a dropped comment open and out of the message", async () => {
    const workspace = await gitWorkspace();
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    await comment(workspace.id, 1);
    const two = await comment(workspace.id, 2);
    await comment(workspace.id, 3);
    await json(await stage(workspace.id, { staged: true }));
    await json(await stage(workspace.id, { staged: false, ids: [two.id] }));

    await json(await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: "Go" }));
    await until(() => said(agent.id).length > 0);
    expect(said(agent.id)[0]).toContain("Fix line 1.");
    expect(said(agent.id)[0]).not.toContain("Fix line 2.");
    expect(said(agent.id)[0]).toContain("Fix line 3.");
    expect(await open(workspace.id)).toMatchObject([{ id: two.id, staged: false }]);
  });

  it("keep the images of the message and go with it", async () => {
    const workspace = await gitWorkspace();
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    await comment(workspace.id, 1);
    await json(await stage(workspace.id, { staged: true }));
    await json(
      await server.request("POST", `/api/agents/${agent.id}/prompt`, {
        message: "Look",
        images: [{ mimeType: "image/png", data: FAKE_PNG }],
      }),
    );
    await until(() => said(agent.id).length > 0);
    expect(said(agent.id)[0]).toContain("Look");
    expect(said(agent.id)[0]).toContain("Fix line 1.");
    // The reply comes after the user message, so wait for it too; it can arrive in a later stdout chunk.
    await until(() =>
      (server.events.eventsOf(`agent:${agent.id}`) as AgentEvent[]).some((event) =>
        JSON.stringify(event).includes("[1 images]"),
      ),
    );
    expect(await open(workspace.id)).toEqual([]);
  });

  it("keep the steer choice of a message sent while the chat works", async () => {
    const workspace = await gitWorkspace();
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    await json(
      await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: "slow:800" }),
    );
    await until(() => said(agent.id).length > 0);
    await comment(workspace.id, 1);
    await json(await stage(workspace.id, { staged: true }));
    await json(
      await server.request("POST", `/api/agents/${agent.id}/prompt`, {
        message: "Now",
        whileBusy: "steer",
      }),
    );
    const queues = () =>
      (server.events.eventsOf(`agent:${agent.id}`) as AgentEvent[]).flatMap((event) => {
        const pi =
          event.type === "pi" ? (event.event as { type: string; steering?: string[] }) : undefined;
        return pi?.type === "queue_update" ? [pi] : [];
      });
    await until(() => queues().length > 0);
    expect(queues()[0]?.steering?.[0]).toContain("Fix line 1.");
    expect(await open(workspace.id)).toEqual([]);
  });

  it("stay staged when the message is a slash command", async () => {
    const workspace = await gitWorkspace();
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    await comment(workspace.id, 1);
    await json(await stage(workspace.id, { staged: true }));
    await json(
      await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: " /compact" }),
    );
    await until(() => said(agent.id).length > 0);
    expect(said(agent.id)).toEqual([" /compact"]);
    expect(await open(workspace.id)).toMatchObject([{ staged: true }]);
  });

  it("send a message without comments when none is staged", async () => {
    const workspace = await gitWorkspace();
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    await comment(workspace.id, 1);
    await json(await server.request("POST", `/api/agents/${agent.id}/prompt`, { message: "Hi" }));
    await until(() => said(agent.id).length > 0);
    expect(said(agent.id)).toEqual(["Hi"]);
    expect(await open(workspace.id)).toHaveLength(1);
  });
});
