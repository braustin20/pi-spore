import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError } from "@pi-spore/module-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { attachUpgrades, SocketRouter } from "./sockets.js";
import { silentLog, TEST_TOKEN } from "./testing.js";

let server: Server;
let router: SocketRouter;
let port: number;

beforeEach(async () => {
  server = createServer((_request, response) => response.end());
  router = new SocketRouter(silentLog);
  attachUpgrades(server, TEST_TOKEN, { allowedHosts: [], allowedLogins: [] }, (pathname) =>
    router.route(pathname),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});
afterEach(() => {
  router.close();
  server.close();
});

/** The first frame the socket at `path` gets, or the status its upgrade was refused with. */
function outcome(path: string): Promise<{ frame: string } | { status: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${TEST_TOKEN}`);
    socket.on("message", (data) => {
      resolve({ frame: String(data) });
      socket.terminate();
    });
    socket.on("unexpected-response", (_request, response) =>
      resolve({ status: response.statusCode ?? 0 }),
    );
    socket.on("error", () => {});
  });
}

describe("SocketRouter", () => {
  it("routes by module and pattern, with decoded params", async () => {
    router
      .forModule("demo")
      .add("/:id/socket", (params) => (socket) => socket.send(params.id ?? ""));
    expect(await outcome("/api/demo/a%20b/socket")).toEqual({ frame: "a b" });
    expect(await outcome("/api/other/a/socket")).toEqual({ status: 404 });
    expect(await outcome("/api/demo/a/socket/more")).toEqual({ status: 404 });
    expect(await outcome("/api/demo//socket")).toEqual({ status: 404 });
  });

  it("refuses an upgrade with the status of the ApiError its opener throws", async () => {
    router.forModule("demo").add("/:id", () => {
      throw new ApiError(409, "busy", "Busy");
    });
    expect(await outcome("/api/demo/x")).toEqual({ status: 409 });
  });
});
