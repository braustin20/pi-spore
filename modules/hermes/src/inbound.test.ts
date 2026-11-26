// Requests from Hermes through the MCP listener (card Hermes 1.3), with a FAKE MCP client, a FAKE Tailscale lookup
// (loopback), and the FAKE Pi. Passing tests here are not live proof: that is card Hermes 1.5.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@pi-spore/mod-agents/server";
import type { ChatState, HermesHandoff, Inbox } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeMcpClient, type Harness, harness, rawRequest } from "./test-helpers.js";

let scratch: string;
let open: Harness[];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-hermes-in-")));
  open = [];
});
afterEach(async () => {
  for (const h of open) await h.close();
  // A kept home (the restart test) lives in scratch too, so it goes after the servers on it closed.
  rmSync(scratch, { recursive: true, force: true });
});

const TEXT = "FAKE-REQUEST-TEXT-7f3a: make the build pass";

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Turns the listener on for this harness, with `projectIds` as the allowed targets, and returns a FAKE client. */
async function listen(h: Harness, projectIds: string[]) {
  h.settings({
    enabled: true,
    mcp: { enabled: true, port: h.mcpPort },
    inbound: { projects: projectIds },
  });
  expect(await json(await h.server.request("GET", "/api/hermes/mcp"))).toEqual({
    state: "listening",
    url: `http://127.0.0.1:${h.mcpPort}/mcp`,
  });
  return fakeMcpClient(`http://127.0.0.1:${h.mcpPort}/mcp`, h.mcpToken);
}

/** A folder project with an in-place workspace and no chat yet, allowed as a target, and the listener on. */
async function start(options: Parameters<typeof harness>[0] = {}, name = "app") {
  const h = await harness(options);
  open.push(h);
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
  const { project } = await json<{ project: { id: string } }>(
    await h.server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await json<{ workspace: { id: string } }>(
    await h.server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name,
      isolation: "in-place",
    }),
    201,
  );
  const client = await listen(h, [project.id]);
  const body = {
    request_id: "r-1",
    target: workspace.id,
    kind: "task",
    title: "Fix the build",
    text: TEXT,
    hop_count: 0,
  };
  return { h, folder, projectId: project.id, workspaceId: workspace.id, client, body };
}

async function request(h: Harness, requestId: string): Promise<HermesHandoff> {
  const { handoffs } = await json<{ handoffs: HermesHandoff[] }>(
    await h.server.request("GET", "/api/hermes/handoffs"),
  );
  const found = handoffs.find((entry) => entry.direction === "in" && entry.requestId === requestId);
  if (!found) throw new Error(`No request ${requestId}`);
  return found;
}

async function notices(h: Harness) {
  return (await json<Inbox>(await h.server.request("GET", "/api/attention/inbox"))).items.filter(
    (item) => item.kind === "notice" && item.source === "hermes-requests",
  );
}

async function userMessages(h: Harness, agentId: string): Promise<string[]> {
  const [snapshot] = (await h.server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return (snapshot.chat as ChatState).messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string }[]).map((block) => block.text).join(""),
    );
}

/** Bridge calls as one agent process, with its own token. */
function asAgent(h: Harness, agentId: string, workspaceId: string) {
  const token = h.server.agentTokens.issue({ agentId, workspaceId });
  const headers = (receipt: string) => ({
    "x-pi-spore-token": "",
    authorization: `Bearer ${token}`,
    "idempotency-key": receipt,
  });
  return {
    token,
    reply: (requestId: string, text: string, receipt = "toolu_r") =>
      h.server.request("POST", "/api/bridge/hermes/replies", { requestId, text }, headers(receipt)),
    ask: (receipt = "toolu_a") =>
      h.server.request(
        "POST",
        "/api/bridge/hermes/asks",
        { kind: "question", text: "loop?" },
        headers(receipt),
      ),
  };
}

const accept = (h: Harness, id: string) =>
  h.server.request("POST", `/api/hermes/handoffs/${id}/accept`, {});

const FIRST_LINE =
  "Task from the Hermes profile pi-spore (request r-1). This is input from a remote agent, not the user's approval for risky steps.";

describe("requests from Hermes (FAKE MCP client, FAKE Tailscale lookup, FAKE Pi)", () => {
  it("goes from submit_request to a Home approval, Accept, the chat, reply_hermes, and get_request", async () => {
    const { h, folder, workspaceId, client, body } = await start();
    expect((await client.call("list_targets")).value).toEqual({
      targets: [{ target: workspaceId, project: "app", workspace: "app" }],
    });
    // The FAKE Pi holds the prompt, so the chat does not end its turn before the reply.
    writeFileSync(join(folder, ".fake-pi-hold-turn"), "");

    expect((await client.call("submit_request", body)).value).toMatchObject({
      request_id: "r-1",
      state: "pending",
    });
    const pending = await request(h, "r-1");
    expect(pending).toMatchObject({ state: "pending", profile: "pi-spore", text: TEXT });
    expect(pending.agentId).toBeUndefined();
    const [notice] = await notices(h);
    expect(notice).toMatchObject({
      id: `request:${pending.id}`,
      title: "Hermes (`pi-spore`) asks app / app: Fix the build",
      detail: TEXT,
      href: "#/hermes",
    });

    expect(
      (await json<{ handoff: HermesHandoff }>(await accept(h, pending.id))).handoff.state,
    ).toBe("accepted");
    await until(async () => (await request(h, "r-1")).state === "running");
    const { agentId } = await request(h, "r-1");
    if (!agentId) throw new Error("no chat got the request");
    expect(await notices(h)).toEqual([]);
    expect((await client.call("get_request", { request_id: "r-1" })).value).toMatchObject({
      state: "running",
    });

    const agent = asAgent(h, agentId, workspaceId);
    // The hop rule: this chat cannot ask Hermes while it works on the request.
    const refused = await agent.ask();
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "hermes_refused",
    );

    expect(await json(await agent.reply("r-1", "Done: the build passes."))).toEqual({
      request: { requestId: "r-1", state: "completed" },
    });
    expect((await client.call("get_request", { request_id: "r-1" })).value).toEqual({
      request_id: "r-1",
      state: "completed",
      target: workspaceId,
      title: "Fix the build",
      result: "Done: the build passes.",
    });

    rmSync(join(folder, ".fake-pi-hold-turn"));
    await until(async () => (await userMessages(h, agentId)).length > 0);
    const [first] = await userMessages(h, agentId);
    expect(first?.startsWith(`${FIRST_LINE}\n\nTask: Fix the build\n\n${TEXT}\n\n`)).toBe(true);
    expect(first).toContain('call reply_hermes with request_id "r-1"');

    // Neither the MCP token nor the request text reaches the log.
    expect(JSON.stringify(h.log)).not.toContain(h.mcpToken);
    expect(JSON.stringify(h.log.filter((line) => line.level === "info"))).not.toContain(TEXT);
    expect(JSON.stringify(h.log)).not.toContain(TEXT);
  });

  it("stores cancelled with the reason on Decline, and Hermes reads it", async () => {
    const { h, client, body } = await start();
    await client.call("submit_request", body);
    const { id } = await request(h, "r-1");
    const declined = await json<{ handoff: HermesHandoff }>(
      await h.server.request("POST", `/api/hermes/handoffs/${id}/decline`, { reason: "not now" }),
    );
    expect(declined.handoff.state).toBe("cancelled");
    expect((await client.call("get_request", { request_id: "r-1" })).value).toMatchObject({
      state: "cancelled",
      reason: "Declined by the user: not now",
    });
    expect(await notices(h)).toEqual([]);
    // Decided once: a late Accept changes nothing.
    expect((await accept(h, id)).status).toBe(409);
  });

  it("gives one request and one Home approval for a repeated request_id, and refuses a changed body", async () => {
    const { h, client, body } = await start();
    const first = await client.call("submit_request", body);
    const again = await client.call("submit_request", body);
    expect(again.value).toEqual(first.value);
    const { handoffs } = await json<{ handoffs: HermesHandoff[] }>(
      await h.server.request("GET", "/api/hermes/handoffs"),
    );
    expect(handoffs.filter((entry) => entry.direction === "in")).toHaveLength(1);
    expect(await notices(h)).toHaveLength(1);

    const changed = await client.call("submit_request", { ...body, text: "something else" });
    expect(changed.isError).toBe(true);
    expect(changed.text).toBe(
      "Request r-1 was already sent with a different body; a new request needs a new request_id",
    );
    expect((await request(h, "r-1")).text).toBe(TEXT);
  });

  it("refuses a request whose hop count says it came from a Pi ask", async () => {
    const { h, client, body } = await start();
    const refused = await client.call("submit_request", { ...body, hop_count: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("came from a pi-spore ask");
    expect(await notices(h)).toEqual([]);
  });

  it("refuses a target outside hermes.inbound.projects, and an empty list refuses all", async () => {
    const { h, client, body, projectId } = await start();
    const other = join(scratch, "other");
    mkdirSync(join(other, ".pi-spore"), { recursive: true });
    writeFileSync(join(other, ".pi-spore", "config.toml"), "");
    const { project } = await json<{ project: { id: string } }>(
      await h.server.request("POST", "/api/projects", { path: other }),
      201,
    );
    const { workspace } = await json<{ workspace: { id: string } }>(
      await h.server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "other",
        isolation: "in-place",
      }),
      201,
    );
    const outside = await client.call("submit_request", { ...body, target: workspace.id });
    expect(outside.isError).toBe(true);
    expect(outside.text).toBe(`${workspace.id} is not a target pi-spore allows; call list_targets`);

    const none = await listen(h, []);
    expect((await none.call("list_targets")).value).toEqual({ targets: [] });
    const refused = await none.call("submit_request", body);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is not a target");
    expect(projectId).not.toBe(project.id);
    expect(await notices(h)).toEqual([]);
  });

  it("loses no state and starts no second chat across a restart between Accept and the reply", async () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    const first = await start({ home });
    writeFileSync(join(first.folder, ".fake-pi-hold-turn"), "");
    await first.client.call("submit_request", first.body);
    const { id } = await request(first.h, "r-1");
    await json(await accept(first.h, id));
    await until(async () => (await request(first.h, "r-1")).state === "running");
    const { agentId } = await request(first.h, "r-1");
    if (!agentId) throw new Error("no chat got the request");
    await first.h.close({ keepFake: true });
    open = open.filter((entry) => entry !== first.h);

    const h = await harness({ home, firstId: 1_000, reuse: first.h });
    open.push(h);
    const client = await listen(h, [first.projectId]);
    expect(await request(h, "r-1")).toMatchObject({ state: "running", agentId });
    expect((await client.call("get_request", { request_id: "r-1" })).value).toMatchObject({
      state: "running",
    });
    const { agents } = await json<{ agents: { id: string }[] }>(
      await h.server.request("GET", `/api/agents?workspaceId=${first.workspaceId}`),
    );
    expect(agents.map((agent) => agent.id)).toEqual([agentId]);

    await json(await asAgent(h, agentId, first.workspaceId).reply("r-1", "done"));
    // The request reached the chat once: the restart sent no second first message.
    rmSync(join(first.folder, ".fake-pi-hold-turn"));
    await until(async () => (await userMessages(h, agentId)).length > 0);
    expect(
      (await userMessages(h, agentId)).filter((text) => text.startsWith(FIRST_LINE)),
    ).toHaveLength(1);
    expect((await client.call("get_request", { request_id: "r-1" })).value).toMatchObject({
      state: "completed",
      result: "done",
    });
  });

  it("reminds a chat that ends its turn without reply_hermes once, never again, and keeps the request running", async () => {
    const { h, client, body } = await start();
    await client.call("submit_request", body);
    const { id } = await request(h, "r-1");
    await json(await accept(h, id));
    await until(async () => (await request(h, "r-1")).state === "running");
    const { agentId } = await request(h, "r-1");
    if (!agentId) throw new Error("no chat got the request");
    const reminders = async () =>
      (await userMessages(h, agentId)).filter((text) =>
        text.startsWith(
          "You ended your turn without calling reply_hermes for the Hermes request r-1.",
        ),
      );
    // The FAKE Pi answers the first message without reply_hermes, then the reminder without it too.
    await until(async () => (await reminders()).length >= 1);
    await until(
      async () =>
        (await reminders()).length > 1 || (taken(h, agentId) && (await h.agents.endedRun(agentId))),
    );
    // The second turn ended with no reply: the watch step runs once more after this mark and sends nothing.
    const mark = h.server.services.now();
    h.server.services.jobs.wake("hermes.inbound", id);
    await until(
      async () =>
        (await request(h, "r-1")).state !== "running" ||
        h.server.services.jobs
          .list({ kind: "hermes.inbound" })
          .some((job) => job.state === "waiting" && job.updatedAt > mark),
    );
    expect(await reminders()).toHaveLength(1);
    expect((await userMessages(h, agentId))[0]?.startsWith(FIRST_LINE)).toBe(true);
    expect((await client.call("get_request", { request_id: "r-1" })).value).toMatchObject({
      state: "running",
    });
    // The request still takes its reply.
    await json(
      await asAgent(h, agentId, (await request(h, "r-1")).workspaceId).reply("r-1", "done"),
    );
    expect((await request(h, "r-1")).state).toBe("completed");
  });

  it("cancels before Accept and while the chat works, and says completed steps are not undone after", async () => {
    const { h, folder, client, body } = await start();
    await client.call("submit_request", body);
    expect((await client.call("cancel_request", { request_id: "r-1" })).value).toMatchObject({
      state: "cancelled",
      reason: "Hermes cancelled it",
    });
    expect(await notices(h)).toEqual([]);

    writeFileSync(join(folder, ".fake-pi-hold-turn"), "");
    await client.call("submit_request", { ...body, request_id: "r-2" });
    await json(await accept(h, (await request(h, "r-2")).id));
    await until(async () => (await request(h, "r-2")).state === "running");
    expect((await client.call("cancel_request", { request_id: "r-2" })).value).toMatchObject({
      state: "cancelled",
      note: "The chat was told to stop. Steps it completed are not undone.",
    });
    const after = await client.call("cancel_request", { request_id: "r-2" });
    expect(after.value).toMatchObject({
      state: "cancelled",
      note: "The request already ended (cancelled). Steps the chat completed are not undone.",
    });
    const { agentId } = await request(h, "r-2");
    rmSync(join(folder, ".fake-pi-hold-turn"));
    await until(async () =>
      (await userMessages(h, agentId as string)).some((text) =>
        text.startsWith("Hermes cancelled its request r-2."),
      ),
    );
  });

  it("lets no agent accept a request: the accept route takes only the user token", async () => {
    const { h, client, body, workspaceId } = await start();
    await client.call("submit_request", body);
    const { id } = await request(h, "r-1");
    const { agent } = await json<{ agent: { id: string } }>(
      await h.server.request("POST", "/api/agents", { workspaceId }),
      201,
    );
    const token = h.server.agentTokens.issue({ agentId: agent.id, workspaceId });
    const response = await h.server.request(
      "POST",
      `/api/hermes/handoffs/${id}/accept`,
      {},
      { "x-pi-spore-token": "", authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(401);
    expect((await request(h, "r-1")).state).toBe("pending");
  });

  it("listens only while hermes.enabled and hermes.mcp.enabled are both on", async () => {
    const h = await harness();
    open.push(h);
    const url = `http://127.0.0.1:${h.mcpPort}/mcp`;
    const refused = async () =>
      await expect(rawRequest(url, { body: "{}" })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    const state = async () => await json(await h.server.request("GET", "/api/hermes/mcp"));

    // Both off by default.
    h.settings({ mcp: { port: h.mcpPort } });
    expect(await state()).toEqual({ state: "off" });
    await refused();
    h.settings({ enabled: true, mcp: { port: h.mcpPort } });
    expect(await state()).toEqual({ state: "off" });
    await refused();
    h.settings({ mcp: { enabled: true, port: h.mcpPort } });
    expect(await state()).toEqual({ state: "off" });
    await refused();

    // On, then the status poll closes it once one turns off.
    h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
    expect(await state()).toMatchObject({ state: "listening" });
    expect((await rawRequest(url, { body: "{}" })).status).toBe(401);
    h.settings({ enabled: true, mcp: { enabled: false, port: h.mcpPort } });
    await h.timers.fire(0);
    await refused();
    // A request between a change and the next check is refused, and closes the listener.
    h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
    expect(await state()).toMatchObject({ state: "listening" });
    h.settings({ mcp: { enabled: true, port: h.mcpPort } });
    const late = await rawRequest(url, { body: "{}" });
    expect(late.status).toBe(503);
    expect(JSON.parse(late.body).error.code).toBe("mcp_off");
    await until(async () => {
      try {
        await rawRequest(url, { body: "{}" });
        return false;
      } catch (error) {
        return (error as { code?: string }).code === "ECONNREFUSED";
      }
    });
  });
});

const RESUMED = "pi-spore restarted while you worked on the Hermes request r-1.";

/**
 * True once Pi took every message queued for the chat. Read from the agents module's store, as no route shows it; a
 * test may look, the hermes module never does.
 */
function taken(h: Harness, agentId: string): boolean {
  const row = h.server.store.get<{ pending: number; done: number }>(
    `SELECT SUM(state = 'pending') AS pending, SUM(state = 'done') AS done FROM agents_deliveries
     WHERE agent_id = ?`,
    agentId,
  );
  return row?.pending === 0 && (row.done ?? 0) > 0;
}

describe("requests from Hermes, the hard cases (FAKE MCP client, FAKE Tailscale lookup, FAKE Pi)", () => {
  it("tells the same chat to go on after a restart that cut its work off, once, with no second request message", async () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    const first = await start({ home });
    writeFileSync(join(first.folder, ".fake-pi-hold-turn"), "");
    await first.client.call("submit_request", first.body);
    await json(await accept(first.h, (await request(first.h, "r-1")).id));
    await until(async () => (await request(first.h, "r-1")).state === "running");
    const { agentId } = await request(first.h, "r-1");
    if (!agentId) throw new Error("no chat got the request");
    // Pi has taken the first message (the FAKE holds its turn): the work is under way when pi-spore stops.
    await until(() => taken(first.h, agentId));
    await first.h.close({ keepFake: true });
    open = open.filter((entry) => entry !== first.h);

    const h = await harness({ home, firstId: 1_000, reuse: first.h });
    open.push(h);
    await listen(h, [first.projectId]);
    rmSync(join(first.folder, ".fake-pi-hold-turn"));
    await until(async () =>
      (await userMessages(h, agentId)).some((text) => text.startsWith(RESUMED)),
    );
    const messages = await userMessages(h, agentId);
    const resumed = messages.filter((text) => text.startsWith(RESUMED));
    expect(resumed).toHaveLength(1);
    // The FAKE lost the held first message with its process, so the go-on message carries the whole request.
    expect(resumed[0]).toContain(`${FIRST_LINE}\n\nTask: Fix the build\n\n${TEXT}`);
    expect(messages.filter((text) => text.startsWith(FIRST_LINE)).length).toBeLessThanOrEqual(1);
    const { agents } = await json<{ agents: { id: string }[] }>(
      await h.server.request("GET", `/api/agents?workspaceId=${first.workspaceId}`),
    );
    expect(agents.map((agent) => agent.id)).toEqual([agentId]);
  });

  it("gives a request that waited in Pi's queue behind a busy chat back to that chat after a restart", async () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    const first = await start({ home });
    const { agent } = await json<{ agent: { id: string } }>(
      await first.h.server.request("POST", "/api/agents", { workspaceId: first.workspaceId }),
      201,
    );
    // The FAKE streams this reply for 5 s, so the request goes into Pi's queue as a follow-up.
    await json(
      await first.h.server.request("POST", `/api/agents/${agent.id}/prompt`, {
        message: "slow:5000",
      }),
    );
    await until(async () => {
      const { agent: now } = await json<{ agent: { status: string } }>(
        await first.h.server.request("GET", `/api/agents/${agent.id}`),
      );
      return now.status === "busy";
    });
    await first.client.call("submit_request", first.body);
    await json(await accept(first.h, (await request(first.h, "r-1")).id));
    await until(async () => (await request(first.h, "r-1")).state === "running");
    await until(() => taken(first.h, agent.id));
    // Pi took the request into its queue; it never ran when pi-spore stops.
    expect((await userMessages(first.h, agent.id)).some((text) => text.includes(TEXT))).toBe(false);
    await first.h.close({ keepFake: true });
    open = open.filter((entry) => entry !== first.h);

    const h = await harness({ home, firstId: 1_000, reuse: first.h });
    open.push(h);
    await listen(h, [first.projectId]);
    await until(async () =>
      (await userMessages(h, agent.id)).some((text) => text.startsWith(RESUMED)),
    );
    const resumed = (await userMessages(h, agent.id)).filter((text) => text.startsWith(RESUMED));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain(`${FIRST_LINE}\n\nTask: Fix the build\n\n${TEXT}`);
    expect((await request(h, "r-1")).agentId).toBe(agent.id);
  });

  it("ends a running request when its workspace is archived, and its job too", async () => {
    const { h, folder, client, body, workspaceId } = await start();
    writeFileSync(join(folder, ".fake-pi-hold-turn"), "");
    await client.call("submit_request", body);
    await json(await accept(h, (await request(h, "r-1")).id));
    await until(async () => (await request(h, "r-1")).state === "running");
    const { agentId } = await request(h, "r-1");
    await until(() => taken(h, agentId as string));
    await json(await h.server.request("POST", `/api/agents/${agentId}/stop`, {}));
    await json(
      await h.server.request("POST", `/api/workspaces/${workspaceId}/archive`, { force: true }),
    );
    expect((await client.call("get_request", { request_id: "r-1" })).value).toMatchObject({
      state: "failed",
      reason: "The workspace was archived before the chat replied",
    });
    await until(() =>
      h.server.services.jobs.list({ kind: "hermes.inbound" }).every((job) => job.state === "done"),
    );
  });

  it("leaves out a run's own workspace and its lanes, and refuses them as targets", async () => {
    const h = await harness();
    open.push(h);
    const folder = join(scratch, "repo");
    mkdirSync(join(folder, ".pi-spore"), { recursive: true });
    writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
    writeFileSync(join(folder, "a.txt"), "one\n");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: folder });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const { project } = await json<{ project: { id: string } }>(
      await h.server.request("POST", "/api/projects", { path: folder }),
      201,
    );
    mkdirSync(join(h.server.paths.root, "pipelines"), { recursive: true });
    writeFileSync(
      join(h.server.paths.root, "pipelines", "p.toml"),
      'id = "p"\n\n[[stage]]\nname = "implement"\nrole = "worker"\ntier = "route"\n',
    );
    const { run } = await json<{
      run: { id: string; workspaceId: string; coordinatorAgentId: string };
    }>(await h.server.request("POST", "/api/runs", { projectId: project.id, name: "r" }), 201);
    const token = h.server.agentTokens.issue({
      agentId: run.coordinatorAgentId,
      workspaceId: run.workspaceId,
    });
    const coordinator = (receipt: string) => ({
      "x-pi-spore-token": "",
      authorization: `Bearer ${token}`,
      "idempotency-key": receipt,
    });
    await json(
      await h.server.request(
        "POST",
        "/api/bridge/artifacts",
        { scope: "workspace", path: "briefs/one.md", content: "Build one" },
        coordinator("toolu_brief"),
      ),
    );
    await json(
      await h.server.request(
        "POST",
        "/api/bridge/lanes",
        { name: "one", brief: "briefs/one.md", wave: 1, pipeline: "p" },
        coordinator("toolu_lane"),
      ),
      201,
    );
    // A wave-1 lane gets its own worktree workspace at once, in the background.
    const laneWorkspace = async () =>
      (
        await json<{ run: { lanes: { workspaceId?: string }[] } }>(
          await h.server.request("GET", `/api/runs/${run.id}`),
        )
      ).run.lanes[0]?.workspaceId;
    await until(async () => (await laneWorkspace()) !== undefined);
    const lane = { workspaceId: (await laneWorkspace()) as string };
    const { workspace } = await json<{ workspace: { id: string } }>(
      await h.server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "plain",
        isolation: "in-place",
      }),
      201,
    );
    const client = await listen(h, [project.id]);
    expect((await client.call("list_targets")).value).toEqual({
      targets: [{ target: workspace.id, project: "repo", workspace: "plain" }],
    });
    const body = {
      request_id: "r-1",
      kind: "task",
      title: "Fix the build",
      text: TEXT,
      hop_count: 0,
    };
    for (const target of [run.workspaceId, lane.workspaceId]) {
      const refused = await client.call("submit_request", { ...body, target });
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(`${target} is not a target pi-spore allows; call list_targets`);
    }
    expect(await notices(h)).toEqual([]);
  });

  it("follows every request a chat has: two accepted requests to one workspace both get their reminder", async () => {
    const { h, client, body } = await start();
    await client.call("submit_request", body);
    await client.call("submit_request", { ...body, request_id: "r-2" });
    await json(await accept(h, (await request(h, "r-1")).id));
    await json(await accept(h, (await request(h, "r-2")).id));
    await until(async () => (await request(h, "r-2")).state === "running");
    const { agentId } = await request(h, "r-1");
    expect((await request(h, "r-2")).agentId).toBe(agentId);
    // The FAKE Pi never replies, so each request's watch must see the chat's turns end and remind it.
    const reminded = async (requestId: string) =>
      (await userMessages(h, agentId as string)).some((text) =>
        text.startsWith(
          `You ended your turn without calling reply_hermes for the Hermes request ${requestId}.`,
        ),
      );
    await until(async () => (await reminded("r-1")) && (await reminded("r-2")));
  });

  it("gives the request to the workspace's existing worker chat, where ask_hermes is refused while it is open", async () => {
    const { h, folder, client, body, workspaceId } = await start();
    const { agent } = await json<{ agent: { id: string } }>(
      await h.server.request("POST", "/api/agents", { workspaceId }),
      201,
    );
    writeFileSync(join(folder, ".fake-pi-hold-turn"), "");
    await client.call("submit_request", body);
    await json(await accept(h, (await request(h, "r-1")).id));
    await until(async () => (await request(h, "r-1")).state === "running");
    expect((await request(h, "r-1")).agentId).toBe(agent.id);
    const { agents } = await json<{ agents: { id: string }[] }>(
      await h.server.request("GET", `/api/agents?workspaceId=${workspaceId}`),
    );
    expect(agents.map((entry) => entry.id)).toEqual([agent.id]);
    const chat = asAgent(h, agent.id, workspaceId);
    expect((await chat.ask()).status).toBe(403);
    await json(await chat.reply("r-1", "done"));
    // Once the request ended, the chat may ask Hermes again (it gets past the hop rule).
    const after = await chat.ask("toolu_after");
    expect(((await after.json()) as { error?: { code: string } }).error?.code).not.toBe(
      "hermes_refused",
    );
  });

  it("lets only the chat the request went to reply, and nobody before Accept or after a cancel", async () => {
    const { h, folder, client, body, workspaceId } = await start();
    writeFileSync(join(folder, ".fake-pi-hold-turn"), "");
    await client.call("submit_request", body);
    const other = await json<{ agent: { id: string } }>(
      await h.server.request("POST", "/api/agents/chats", { workspaceId, kind: "side" }),
      201,
    );
    // Before Accept no chat has it.
    const early = await asAgent(h, other.agent.id, workspaceId).reply("r-1", "forged", "toolu_1");
    expect(early.status).toBe(404);
    await json(await accept(h, (await request(h, "r-1")).id));
    await until(async () => (await request(h, "r-1")).state === "running");
    const forged = await asAgent(h, other.agent.id, workspaceId).reply("r-1", "forged", "toolu_2");
    expect(forged.status).toBe(404);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe(
      "request_not_found",
    );
    expect(await request(h, "r-1")).toMatchObject({ state: "running" });
    expect((await request(h, "r-1")).result).toBeUndefined();

    await client.call("cancel_request", { request_id: "r-1" });
    const { agentId } = await request(h, "r-1");
    const late = await asAgent(h, agentId as string, workspaceId).reply("r-1", "late", "toolu_3");
    expect(late.status).toBe(409);
    expect((await request(h, "r-1")).result).toBeUndefined();
    // The cancel woke the request's job, so it ended too.
    await until(() =>
      h.server.services.jobs.list({ kind: "hermes.inbound" }).every((job) => job.state === "done"),
    );
  });

  it("fails a running request whose chat was replaced, and says so to Hermes", async () => {
    const { h, folder, client, body, workspaceId } = await start();
    writeFileSync(join(folder, ".fake-pi-hold-turn"), "");
    await client.call("submit_request", body);
    await json(await accept(h, (await request(h, "r-1")).id));
    await until(async () => (await request(h, "r-1")).state === "running");
    const { agentId } = await request(h, "r-1");
    await until(() => taken(h, agentId as string));
    await json(await h.server.request("POST", `/api/agents/${agentId}/stop`, {}));
    await json(
      await h.server.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
      201,
    );
    await until(async () => (await request(h, "r-1")).state === "failed");
    expect((await client.call("get_request", { request_id: "r-1" })).value).toMatchObject({
      state: "failed",
      reason: "The chat that worked on the request was closed or replaced before it replied",
    });
  });

  it("leaves out the planner workspace of an allowed project", async () => {
    const { h, client, body, projectId, workspaceId } = await start();
    const planner = await json<{ workspace: { id: string } }>(
      await h.server.request("POST", "/api/workspaces/planner", { projectId }),
    );
    expect((await client.call("list_targets")).value).toEqual({
      targets: [{ target: workspaceId, project: "app", workspace: "app" }],
    });
    const refused = await client.call("submit_request", { ...body, target: planner.workspace.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is not a target");
  });

  it.each([
    ["a request_id with a space", { request_id: "r 1" }],
    ["a request_id over 128 characters", { request_id: "r".repeat(129) }],
    ["an unknown kind", { kind: "shell" }],
    ["a title over 200 characters", { title: "t".repeat(201) }],
    ["a text over 8,000 characters", { text: "x".repeat(8_001) }],
    ["a negative hop count", { hop_count: -1 }],
    ["a model override", { model: "openai/gpt-6.1-sol" }],
    ["a provider override", { provider: "nous" }],
  ])("refuses submit_request with %s, and stores nothing", async (_name, change) => {
    const { h, client, body } = await start();
    const refused = await client.call("submit_request", { ...body, ...change });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Invalid submit_request arguments");
    const { handoffs } = await json<{ handoffs: HermesHandoff[] }>(
      await h.server.request("GET", "/api/hermes/handoffs"),
    );
    expect(handoffs).toEqual([]);
    expect(await notices(h)).toEqual([]);
  });

  it("refuses Accept while Hermes is off, and after the target left hermes.inbound.projects", async () => {
    const { h, client, body, projectId } = await start();
    await client.call("submit_request", body);
    const { id } = await request(h, "r-1");
    h.settings({ mcp: { enabled: true, port: h.mcpPort }, inbound: { projects: [projectId] } });
    const off = await accept(h, id);
    expect(off.status).toBe(503);
    h.settings({
      enabled: true,
      mcp: { enabled: true, port: h.mcpPort },
      inbound: { projects: [] },
    });
    const gone = await accept(h, id);
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe(
      "target_not_allowed",
    );
    expect((await request(h, "r-1")).state).toBe("pending");
  });

  it("keeps the routes for handoffs to Hermes away from requests from Hermes", async () => {
    const { h, client, body } = await start();
    await client.call("submit_request", body);
    const { id } = await request(h, "r-1");
    for (const [method, path] of [
      ["POST", `/api/hermes/handoffs/${id}/cancel`],
      ["GET", `/api/hermes/handoffs/${id}/reconcile`],
      ["POST", `/api/hermes/handoffs/${id}/resolve`],
      ["POST", `/api/hermes/handoffs/${id}/controls/p1`],
    ] as const) {
      const response = await h.server.request(method, path, method === "POST" ? {} : undefined);
      expect(response.status).toBe(404);
    }
    expect((await request(h, "r-1")).state).toBe("pending");
  });
});
