import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  ApiError,
  type Logger,
  type ModuleSocket,
  type SocketOpener,
  type SocketRoutes,
} from "@pi-spore/module-api";
import { WebSocket, WebSocketServer } from "ws";
import { guardRequest, type RemoteAccess } from "./guards.js";
import { tokensMatch } from "./token.js";

/** Takes an upgrade that passed the guards. */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

const HEARTBEAT_MS = 30_000;

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

/**
 * Accepts WebSocket upgrades on `server`. Each one must carry the user's token as `?token=`: browsers cannot set
 * headers on a WebSocket, and the page that has the token was served from this origin. Agent tokens never match, so
 * an agent cannot open a socket. `route` picks the handler for a path; no handler answers 404.
 */
export function attachUpgrades(
  server: Server,
  token: string,
  remoteAccess: RemoteAccess,
  route: (pathname: string) => UpgradeHandler | undefined,
): void {
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const login = request.headers["tailscale-user-login"];
    const refusal = guardRequest(
      remoteAccess,
      {
        host: request.headers.host,
        peer: request.socket.remoteAddress,
        login: typeof login === "string" ? login : undefined,
      },
      { origin: request.headers.origin },
    );
    if (refusal) return refuse(socket, `${refusal.status} ${STATUS_TEXT[refusal.status]}`);
    if (!tokensMatch(token, url.searchParams.get("token") ?? undefined)) {
      return refuse(socket, "401 Unauthorized");
    }
    const handler = route(url.pathname);
    if (!handler) return refuse(socket, "404 Not Found");
    handler(request, socket, head);
  });
}

/** Pings every client of `wss` and drops those that did not answer the last ping. Returns a stop function. */
export function keepAlive(wss: WebSocketServer): () => void {
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

interface Route {
  moduleId: string;
  segments: string[];
  open: SocketOpener;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** The WebSocket routes modules add through `host.sockets`. */
export class SocketRouter {
  private readonly routes: Route[] = [];
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly stopHeartbeat = keepAlive(this.wss);

  constructor(private readonly log: Logger) {}

  forModule(moduleId: string): SocketRoutes {
    return {
      add: (path, open) => {
        if (!path.startsWith("/")) throw new Error(`Socket path "${path}" must start with "/"`);
        this.routes.push({ moduleId, segments: path.slice(1).split("/"), open });
      },
    };
  }

  /** The handler for an upgrade at `pathname`, if a module added a route for it. */
  route(pathname: string): UpgradeHandler | undefined {
    const parts = pathname.split("/").slice(1);
    if (parts[0] !== "api") return undefined;
    for (const route of this.routes) {
      if (parts[1] !== route.moduleId) continue;
      const params = matchSegments(route.segments, parts.slice(2));
      if (params) return (request, socket, head) => this.open(route, params, request, socket, head);
    }
    return undefined;
  }

  close(): void {
    this.stopHeartbeat();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  private open(
    route: Route,
    params: Record<string, string>,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    let accept: (socket: ModuleSocket) => void;
    try {
      accept = route.open(params);
    } catch (error) {
      if (error instanceof ApiError) {
        refuse(socket, `${error.status} ${STATUS_TEXT[error.status] ?? "Error"}`);
        return;
      }
      this.log.error("Socket open failed", { module: route.moduleId, error: String(error) });
      refuse(socket, "500 Internal Server Error");
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit("connection", ws, request);
      accept(wrap(ws));
    });
  }
}

/** Params of `parts` against a pattern such as `[":id", "socket"]`, or undefined when it does not match. */
function matchSegments(pattern: string[], parts: string[]): Record<string, string> | undefined {
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    const part = parts[index] as string;
    if (segment.startsWith(":")) {
      if (part === "") return undefined;
      params[segment.slice(1)] = decodeURIComponent(part);
    } else if (segment !== part) return undefined;
  }
  return params;
}

function wrap(ws: WebSocket): ModuleSocket {
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: (code, reason) => ws.close(code, reason),
    onMessage: (listener) => ws.on("message", (data) => listener(String(data))),
    onClose: (listener) => ws.on("close", () => listener()),
  };
}
