// The MCP listener's own guards (card Hermes 1.3), with a FAKE MCP client and a FAKE Tailscale lookup that answers
// loopback. Passing tests here are not live proof: that is card Hermes 1.5.
import { chmodSync } from "node:fs";
import { createServer, Server } from "node:net";
import { join } from "node:path";
import { TEST_TOKEN } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeMcpClient,
  type Harness,
  harness,
  type RawAnswer,
  rawRequest,
} from "../test-helpers.js";
import { MAX_BODY_BYTES, RATE_LIMIT } from "./listener.js";

let h: Harness | undefined;
// A safety net: no test here may bind anything but loopback, even with the address check broken on purpose.
const realListen = Server.prototype.listen;
beforeEach(() => {
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    const host = args[1];
    if (typeof host === "string" && host !== "127.0.0.1")
      throw new Error(`this test refused to bind ${host}`);
    return realListen.apply(this, args as Parameters<Server["listen"]>);
  });
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
});

/** A harness with the listener on, and a request helper that sends the FAKE MCP token unless told otherwise. */
async function on(options: Parameters<typeof harness>[0] = {}) {
  h = await harness(options);
  h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
  const state = await (await h.server.request("GET", "/api/hermes/mcp")).json();
  const url = `http://127.0.0.1:${h.mcpPort}/mcp`;
  const token = h.mcpToken;
  const post = (headers: Record<string, string> = {}, body = initialize) =>
    rawRequest(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...headers,
      },
      body,
    });
  return { h, state, url, post };
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fake", version: "0" },
  },
});

const code = (answer: RawAnswer) =>
  (JSON.parse(answer.body) as { error: { code: string } }).error.code;

describe("the Hermes MCP listener (FAKE MCP client, FAKE Tailscale lookup)", () => {
  it("answers the MCP handshake and lists the four narrow tools", async () => {
    const { state, url, post } = await on();
    expect(state).toEqual({ state: "listening", url });
    const answer = await post();
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } } },
    });
    // A notification gets 202 and no body; GET opens no server stream.
    const notified = await post(
      {},
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notified).toMatchObject({ status: 202, body: "" });
    const stream = await rawRequest(url, {
      method: "GET",
      headers: { authorization: `Bearer ${h?.mcpToken}` },
    });
    expect(stream.status).toBe(405);
    const client = fakeMcpClient(url, h?.mcpToken as string);
    const { result } = await client.rpc("tools/list");
    expect((result?.tools as { name: string }[] | undefined)?.map((tool) => tool.name)).toEqual([
      "list_targets",
      "submit_request",
      "get_request",
      "cancel_request",
    ]);
    expect((await client.rpc("shell/run")).error).toEqual({
      code: -32601,
      message: "Unknown method shell/run",
    });
  });

  it("gives 401 to a wrong token, the user token, and an agent token", async () => {
    const { h, post } = await on();
    const agent = h.server.agentTokens.issue({ agentId: "a1", workspaceId: "w1" });
    for (const token of ["wrong", TEST_TOKEN, agent]) {
      const answer = await post({ authorization: `Bearer ${token}` });
      expect(answer.status).toBe(401);
      expect(code(answer)).toBe("unauthorized");
    }
    const none = await post({ authorization: "" });
    expect(none.status).toBe(401);
    // The user token's header does not count either.
    expect((await post({ authorization: "", "x-pi-spore-token": TEST_TOKEN })).status).toBe(401);
  });

  it("refuses a foreign Host and a browser Origin, even with the right token", async () => {
    const { h, post } = await on();
    for (const host of ["evil.example", `localhost:${h.mcpPort}`, "127.0.0.1"]) {
      const answer = await post({ host });
      expect(answer.status).toBe(403);
      expect(code(answer)).toBe("bad_host");
    }
    const page = await post({ origin: "https://evil.example" });
    expect(page.status).toBe(403);
    expect(code(page)).toBe("bad_origin");
  });

  it("refuses an oversized body", async () => {
    const { post } = await on();
    const answer = await post({}, `{"x":"${"a".repeat(MAX_BODY_BYTES)}"}`);
    expect(answer.status).toBe(413);
    expect(code(answer)).toBe("body_too_large");
  });

  it("caps the request rate, before the token check", async () => {
    const { post } = await on();
    const statuses: number[] = [];
    for (let i = 0; i <= RATE_LIMIT; i += 1)
      statuses.push((await post({ authorization: "Bearer wrong" })).status);
    expect(statuses.slice(0, RATE_LIMIT).every((status) => status === 401)).toBe(true);
    expect(statuses[RATE_LIMIT]).toBe(429);
    expect((await post()).status).toBe(429);
  });

  it("does not start without a Tailscale address, and says why", async () => {
    h = await harness({ mcpLookup: () => undefined });
    h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
    const state = await (await h.server.request("GET", "/api/hermes/mcp")).json();
    const why =
      "The Hermes MCP listener did not start: this machine has no Tailscale address (an IPv4 address in 100.64.0.0/10 on a tailscale0 or utun interface)";
    expect(state).toEqual({ state: "failed", error: why });
    expect(h.log).toContainEqual({ level: "error", message: why });
    await expect(
      rawRequest(`http://127.0.0.1:${h.mcpPort}/mcp`, { body: "{}" }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it.each(["0.0.0.0", "192.168.1.20", "::"])("never binds %s", async (address) => {
    h = await harness({ mcpLookup: () => address });
    h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
    expect(await (await h.server.request("GET", "/api/hermes/mcp")).json()).toEqual({
      state: "failed",
      error: `The Hermes MCP listener did not start: ${address} is not a Tailscale address, and it binds no other`,
    });
  });

  it("does not start without a usable token file, and names the path only", async () => {
    h = await harness();
    const file = join(h.server.paths.root, "hermes", "mcp.token");
    chmodSync(file, 0o644);
    h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
    expect(await (await h.server.request("GET", "/api/hermes/mcp")).json()).toEqual({
      state: "failed",
      error: `The Hermes MCP listener did not start: The Hermes MCP token file ${file} has mode 0644; it must be 0600 or narrower`,
    });
    expect(JSON.stringify(h.log)).not.toContain(h.mcpToken);
  });

  it("answers JSON-RPC errors for a bad path, content type, JSON, batch, method, and tool", async () => {
    const { url, post } = await on();
    const elsewhere = await rawRequest(url.replace("/mcp", "/other"), {
      headers: { authorization: `Bearer ${h?.mcpToken}` },
      body: initialize,
    });
    expect(elsewhere.status).toBe(404);
    expect((await post({ "content-type": "text/plain" })).status).toBe(415);
    const broken = await post({}, "{not json");
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body).error.code).toBe(-32700);
    const batch = await post({}, `[${initialize}]`);
    expect(batch.status).toBe(400);
    expect(JSON.parse(batch.body).error.code).toBe(-32600);
    const client = fakeMcpClient(url, h?.mcpToken as string);
    expect((await client.rpc("tools/call", { name: "run_shell", arguments: {} })).error).toEqual({
      code: -32602,
      message: "Unknown tool run_shell",
    });
    const old = await client.rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(old.result?.protocolVersion).toBe("2025-11-25");
    const known = await client.rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(known.result?.protocolVersion).toBe("2025-06-18");
  });

  it("answers 503 once the token file breaks after start, and logs no token", async () => {
    const { h, post } = await on();
    chmodSync(join(h.server.paths.root, "hermes", "mcp.token"), 0o644);
    const answer = await post();
    expect(answer.status).toBe(503);
    expect(code(answer)).toBe("mcp_token_unusable");
    expect(JSON.stringify(h.log)).not.toContain(h.mcpToken);
  });

  it("does not start on a port in use, and says why", async () => {
    h = await harness();
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(h?.mcpPort, "127.0.0.1", resolve));
    try {
      h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
      const state = (await (await h.server.request("GET", "/api/hermes/mcp")).json()) as {
        state: string;
        error: string;
      };
      expect(state.state).toBe("failed");
      expect(state.error).toContain(`did not start on 127.0.0.1:${h.mcpPort}`);
      expect(state.error).toContain("EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it("closes when the Tailscale address goes away, and opens again when it is back", async () => {
    let address: string | undefined = "127.0.0.1";
    h = await harness({ mcpLookup: () => address });
    h.settings({ enabled: true, mcp: { enabled: true, port: h.mcpPort } });
    const state = async () =>
      (await (h as Harness).server.request("GET", "/api/hermes/mcp")).json();
    const url = `http://127.0.0.1:${h.mcpPort}/mcp`;
    expect(await state()).toMatchObject({ state: "listening" });
    address = undefined;
    expect(await state()).toMatchObject({ state: "failed" });
    await expect(rawRequest(url, { body: "{}" })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    address = "127.0.0.1";
    expect(await state()).toMatchObject({ state: "listening" });
    expect((await rawRequest(url, { body: "{}" })).status).toBe(401);
  });
});
