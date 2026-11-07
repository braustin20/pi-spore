import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError } from "@pi-spore/module-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WebSocketHub } from "./events.js";
import { attachUpgrades } from "./sockets.js";
import { silentLog, TEST_TOKEN } from "./testing.js";

let server: Server;
let hub: WebSocketHub;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  server = createServer((_request, response) => response.end());
  hub = new WebSocketHub(silentLog);
  attachUpgrades(server, TEST_TOKEN, (pathname) =>
    pathname === "/api/ws" ? hub.upgrade : undefined,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  hub.close();
  server.close();
});

interface Frame {
  type: string;
  topic?: string;
  event?: unknown;
  message?: string;
}

/** Opens a socket and collects every frame it receives. */
async function connect(options: { token?: string; host?: string; origin?: string } = {}) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/ws?token=${options.token ?? TEST_TOKEN}`,
    {
      headers: {
        ...(options.host ? { host: options.host } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      },
    },
  );
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  await once(socket, "open");
  return { socket, frames };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error("Timed out waiting");
}

/** Resolves with the HTTP status of a refused upgrade. */
function refusedStatus(options: {
  token?: string;
  host?: string;
  origin?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws?token=${options.token ?? TEST_TOKEN}`,
      {
        headers: {
          ...(options.host ? { host: options.host } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
        },
      },
    );
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.on("open", () => reject(new Error("The upgrade was accepted")));
    socket.on("error", () => {});
  });
}

describe("WebSocketHub", () => {
  it("sends the snapshot, then live events, only to subscribers of that topic", async () => {
    hub.onSubscribe("agent:", (topic) => [{ snapshot: topic }]);
    const a = await connect();
    const b = await connect();
    a.socket.send(JSON.stringify({ type: "subscribe", topic: "agent:1" }));
    b.socket.send(JSON.stringify({ type: "subscribe", topic: "agent:2" }));
    await until(() => a.frames.length === 1 && b.frames.length === 1);

    hub.publish("agent:1", { n: 1 });
    await until(() => a.frames.length === 2);

    expect(a.frames).toEqual([
      { type: "event", topic: "agent:1", event: { snapshot: "agent:1" } },
      { type: "event", topic: "agent:1", event: { n: 1 } },
    ]);
    expect(b.frames).toEqual([{ type: "event", topic: "agent:2", event: { snapshot: "agent:2" } }]);
  });

  it("delivers events published while the snapshot is built after it, in order", async () => {
    let release: () => void = () => {};
    hub.onSubscribe("agent:", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ["snapshot"];
    });
    const { socket, frames } = await connect();
    socket.send(JSON.stringify({ type: "subscribe", topic: "agent:1" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.publish("agent:1", "during-1");
    hub.publish("agent:1", "during-2");
    release();
    await until(() => frames.length === 3);
    hub.publish("agent:1", "after");
    await until(() => frames.length === 4);

    expect(frames.map((frame) => frame.event)).toEqual([
      "snapshot",
      "during-1",
      "during-2",
      "after",
    ]);
  });

  it("stops sending after unsubscribe", async () => {
    hub.onSubscribe("agent:", () => []);
    const { socket, frames } = await connect();
    socket.send(JSON.stringify({ type: "subscribe", topic: "agent:1" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.send(JSON.stringify({ type: "unsubscribe", topic: "agent:1" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.publish("agent:1", "late");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toEqual([]);
  });

  it("reports unknown topics and refused snapshots as errors", async () => {
    hub.onSubscribe("agent:", () => {
      throw new ApiError(404, "agent_not_found", "No agent 9");
    });
    const { socket, frames } = await connect();
    socket.send(JSON.stringify({ type: "subscribe", topic: "nope:1" }));
    socket.send(JSON.stringify({ type: "subscribe", topic: "agent:9" }));
    socket.send("not json");
    await until(() => frames.length === 3);
    expect(frames).toEqual(
      expect.arrayContaining([
        { type: "error", topic: "nope:1", message: "No such topic: nope:1" },
        { type: "error", topic: "agent:9", message: "No agent 9" },
        { type: "error", message: "Messages must be JSON" },
      ]),
    );
  });

  it("refuses upgrades without the token, from other hosts, and from other sites", async () => {
    expect(await refusedStatus({ token: "wrong" })).toBe(401);
    expect(await refusedStatus({ host: `evil.example:${port}` })).toBe(403);
    expect(await refusedStatus({ origin: "https://evil.example" })).toBe(403);
  });

  it("accepts a same-origin page", async () => {
    const { socket } = await connect({ origin: `http://127.0.0.1:${port}` });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
