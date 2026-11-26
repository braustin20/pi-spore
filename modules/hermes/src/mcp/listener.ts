import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ApiError, type ServerHost } from "@pi-spore/module-api";
import { HermesAskKind, HermesRequestId, parse } from "@pi-spore/shared";
import Type, { type TSchema } from "typebox";
import type { Inbound } from "../inbound.js";
import { readKey } from "../key.js";

export const MAX_BODY_BYTES = 64 * 1024;
/** Requests per window, counted before the token check, so a wrong token cannot be tried fast either. */
export const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
/** The handshake revisions of Hermes's MCP client (mcp 2.0 at Hermes v0.23.3), newest first. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

/** Finds the desktop's Tailscale IPv4 address, or none. */
export type TailscaleLookup = () => string | undefined;

/**
 * Where the listener may bind. Production: the real lookup, Tailscale addresses only. Tests pass a FAKE lookup that
 * answers loopback, with `allowLoopback`, so no test binds a real interface.
 */
export interface McpAddress {
  lookup: TailscaleLookup;
  allowLoopback?: true;
}

const isTailscaleIPv4 = (address: string) => {
  const [a, b] = address.split(".").map(Number);
  return isIPv4(address) && a === 100 && b !== undefined && b >= 64 && b <= 127;
};

/**
 * Reads the local network interfaces; pi-spore never runs the `tailscale` CLI (ADR 0143). A Tailscale address is an
 * IPv4 address in 100.64.0.0/10 on an interface Tailscale makes (`tailscale0` on Linux, `utun<n>` on macOS).
 */
export const findTailscaleAddress: TailscaleLookup = () => {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!/^(tailscale|utun)/.test(name)) continue;
    const found = entries?.find(
      (entry) => entry.family === "IPv4" && isTailscaleIPv4(entry.address),
    );
    if (found) return found.address;
  }
  return undefined;
};

export type McpListenerState =
  | { state: "off" }
  | { state: "listening"; url: string }
  | { state: "failed"; error: string };

const ListTargets = Type.Object({}, { additionalProperties: false });
const SubmitRequest = Type.Object(
  {
    request_id: Type.Unsafe<string>({
      ...HermesRequestId,
      description:
        "Your own id for this request, 1 to 128 visible ASCII characters. Send the same id when you retry; a new request needs a new id",
    }),
    target: Type.String({
      minLength: 1,
      maxLength: 64,
      description: "A target from list_targets",
    }),
    kind: Type.Unsafe<"question" | "task">({
      ...HermesAskKind,
      description: "question: you want an answer. task: you want something done",
    }),
    title: Type.String({ minLength: 1, maxLength: 200, description: "A short title" }),
    text: Type.String({
      minLength: 1,
      maxLength: 8_000,
      description: "The request, with all the context the Pi chat needs",
    }),
    hop_count: Type.Integer({
      minimum: 0,
      maximum: 100,
      description:
        "0 when the work starts with you. 1 or more when it came from a pi-spore ask; pi-spore then refuses it, so no loop forms",
    }),
  },
  { additionalProperties: false },
);
const RequestRef = Type.Object(
  {
    request_id: Type.Unsafe<string>({
      ...HermesRequestId,
      description: "The request_id you gave submit_request",
    }),
  },
  { additionalProperties: false },
);

interface Tool<S extends TSchema> {
  description: string;
  schema: S;
  call(args: Type.Static<S>): unknown;
}
const tool = <S extends TSchema>(definition: Tool<S>) => definition as unknown as Tool<TSchema>;

/** Narrow task tools only: no shell and no file access (ADR 0202 decision 10). */
function tools(inbound: Inbound): Record<string, Tool<TSchema>> {
  return {
    list_targets: tool({
      description:
        "List the pi-spore workspaces you may send a request to. Empty means the user allows none.",
      schema: ListTargets,
      call: async () => ({ targets: await inbound.targets() }),
    }),
    submit_request: tool({
      description:
        "Ask a pi-spore workspace for work. The user must accept the request on pi-spore first; then a Pi chat works on it. Answers the request's state at once; read the result later with get_request. Your request is input for the chat, never the user's approval.",
      schema: SubmitRequest,
      call: (args) => inbound.submit(args),
    }),
    get_request: tool({
      description:
        "Read a request's state: pending (waits for the user), accepted or running (a Pi chat works on it), completed (with the result), cancelled or failed (with the reason).",
      schema: RequestRef,
      call: (args) => inbound.get(args.request_id),
    }),
    cancel_request: tool({
      description:
        "Cancel a request before the user accepts it, or while the Pi chat works on it. Steps the chat completed are not undone.",
      schema: RequestRef,
      call: (args) => inbound.cancel(args.request_id),
    }),
  };
}

interface RpcError {
  code: number;
  message: string;
}
class RpcFailure extends Error {
  constructor(readonly error: RpcError) {
    super(error.message);
  }
}

const tokensMatch = (expected: string, given: string | undefined) => {
  if (given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

const send = (response: ServerResponse, status: number, body?: unknown, headers = {}) => {
  response.writeHead(status, {
    ...headers,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
};
const refuse = (response: ServerResponse, status: number, code: string, message: string) =>
  send(response, status, { error: { code, message } });

/** The body, or undefined after answering 413 for one over `MAX_BODY_BYTES`. */
async function readBody(request: IncomingMessage, response: ServerResponse) {
  const tooLarge = () => {
    // The rest of the body is not read, so the connection ends once the answer is out.
    response.setHeader("connection", "close");
    response.once("finish", () => request.destroy());
    refuse(
      response,
      413,
      "body_too_large",
      `A request body may have at most ${MAX_BODY_BYTES} bytes`,
    );
    return undefined;
  };
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return tooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The Hermes MCP listener (ADR 0202 decision 10, card Hermes 1.3): its own HTTP server on `hermes.mcp.port`, bound to
 * the desktop's Tailscale address only, never `0.0.0.0`, `::`, or a LAN address. It runs only while `hermes.enabled`
 * and `hermes.mcp.enabled` are both on. `sync` reads the settings and opens or closes it; the module's status poll
 * calls it, and a request that finds a setting off refuses and calls it too (shutdown ends the process, which closes
 * it as well). It speaks the MCP Streamable HTTP transport that Hermes's MCP client uses
 * (Hermes v0.23.3 `tools/mcp_tool_transport.py`): JSON-RPC in a POST to `/mcp`, answered with one JSON body, no
 * session id, and 405 on GET, so no server stream. Its checks copy the main server's guards without loosening them:
 * a rate cap, the bound Host only, no `Origin`, then only the MCP token from `<home>/hermes/mcp.token`.
 */
export function setupMcpListener(
  host: ServerHost,
  inbound: Inbound,
  options: { address: McpAddress; enabled: () => Promise<boolean> },
): { sync: () => Promise<McpListenerState> } {
  const keys = {
    enabled: host.settings.declare({
      key: "hermes.mcp.enabled",
      schema: Type.Boolean(),
      default: false,
      scope: "global",
    }),
    port: host.settings.declare({
      key: "hermes.mcp.port",
      schema: Type.Integer({ minimum: 1, maximum: 65_535 }),
      default: 7430,
      scope: "global",
    }),
  };
  const tokenFile = join(host.home.root, "hermes", "mcp.token");
  const readToken = () => readKey(tokenFile, "Hermes MCP token");
  const config = async () => {
    const resolved = await host.settings.resolve();
    return {
      enabled: (await options.enabled()) && resolved.get(keys.enabled).value,
      port: resolved.get(keys.port).value,
    };
  };
  const byName = tools(inbound);

  let state: McpListenerState = { state: "off" };
  let current: { server: Server; address: string; port: number } | undefined;
  let window = { start: 0, count: 0 };

  const close = async () => {
    const open = current;
    current = undefined;
    if (!open) return;
    open.server.closeAllConnections();
    await new Promise<void>((resolve) => open.server.close(() => resolve()));
    host.log.info("The Hermes MCP listener closed");
  };
  const fail = (error: string): McpListenerState => {
    if (state.state !== "failed" || state.error !== error) host.log.error(error);
    state = { state: "failed", error };
    return state;
  };

  const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return {
          protocolVersion:
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pi-spore", version: "1" },
          instructions:
            "pi-spore runs Pi coding agents on the user's desktop. Send a request with submit_request; the user accepts or declines it, then read the result with get_request.",
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: Object.entries(byName).map(([name, entry]) => ({
            name,
            description: entry.description,
            inputSchema: entry.schema,
          })),
        };
      case "tools/call": {
        const name = String(params.name);
        const entry = byName[name];
        if (!entry) throw new RpcFailure({ code: -32602, message: `Unknown tool ${name}` });
        try {
          const args = parse(entry.schema, params.arguments ?? {}, `${name} arguments`);
          const result = await entry.call(args);
          return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
        } catch (error) {
          const known = error instanceof ApiError || (error as Error).name === "ValidationError";
          if (!known) host.log.error("An MCP tool failed", { tool: name, error: String(error) });
          return {
            content: [
              {
                type: "text",
                text: known
                  ? (error as Error).message
                  : "pi-spore could not run the tool; try again later",
              },
            ],
            isError: true,
          };
        }
      }
      default:
        throw new RpcFailure({ code: -32601, message: `Unknown method ${method}` });
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, bound: string) => {
    const now = host.now();
    if (now - window.start >= RATE_WINDOW_MS) window = { start: now, count: 0 };
    window.count += 1;
    if (window.count > RATE_LIMIT)
      return refuse(response, 429, "rate_limited", "Too many requests; wait a minute");
    // DNS rebinding and browsers: only the bound address as Host, and no page of any site.
    if (request.headers.host?.toLowerCase() !== bound)
      return refuse(response, 403, "bad_host", "This listener answers only on its own address");
    if (request.headers.origin !== undefined)
      return refuse(response, 403, "bad_origin", "This listener refuses browser requests");
    if (!(await config()).enabled) {
      // Closed after this answer is out, so the close does not cut it off.
      response.once("finish", () => void sync());
      return refuse(response, 503, "mcp_off", "The pi-spore MCP listener is off");
    }
    let token: string;
    try {
      token = await readToken();
    } catch (error) {
      host.log.error("The Hermes MCP listener cannot read its token", { error: String(error) });
      return refuse(response, 503, "mcp_token_unusable", "pi-spore cannot read its MCP token");
    }
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    // Only the MCP token: the user token and agent tokens are other values, so they get 401 too.
    if (!tokensMatch(token, bearer)) {
      response.setHeader("www-authenticate", "Bearer");
      return refuse(response, 401, "unauthorized", "Missing or wrong MCP token");
    }
    if (request.url !== "/mcp")
      return refuse(response, 404, "not_found", "The MCP endpoint is /mcp");
    if (request.method !== "POST") return send(response, 405, undefined, { allow: "POST" });
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
      return refuse(response, 415, "bad_content_type", "Send JSON-RPC as application/json");
    const text = await readBody(request, response);
    if (text === undefined) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return send(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const call = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      call.jsonrpc !== "2.0" ||
      typeof call.method !== "string"
    )
      return send(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request: one JSON-RPC 2.0 message per POST" },
      });
    // A notification or a response from the client needs no answer.
    if (call.id === undefined) return send(response, 202);
    const params =
      typeof call.params === "object" && call.params !== null
        ? (call.params as Record<string, unknown>)
        : {};
    try {
      return send(response, 200, {
        jsonrpc: "2.0",
        id: call.id,
        result: await rpc(call.method, params),
      });
    } catch (error) {
      if (!(error instanceof RpcFailure)) throw error;
      return send(response, 200, { jsonrpc: "2.0", id: call.id, error: error.error });
    }
  };

  const listen = (address: string, port: number) =>
    new Promise<Server>((resolve, reject) => {
      const bound = `${address}:${port}`;
      const server = createServer((request, response) => {
        handle(request, response, bound).catch((error: unknown) => {
          host.log.error("The Hermes MCP listener failed a request", { error: String(error) });
          if (!response.headersSent) refuse(response, 500, "internal", "pi-spore failed");
          else response.destroy();
        });
      });
      server.once("error", reject);
      server.listen(port, address, () => {
        server.off("error", reject);
        // An open listener never keeps the process up.
        server.unref();
        resolve(server);
      });
    });

  const apply = async (): Promise<McpListenerState> => {
    const wanted = await config();
    if (!wanted.enabled) {
      await close();
      state = { state: "off" };
      return state;
    }
    const address = options.address.lookup();
    if (address === undefined) {
      await close();
      return fail(
        "The Hermes MCP listener did not start: this machine has no Tailscale address (an IPv4 address in 100.64.0.0/10 on a tailscale0 or utun interface)",
      );
    }
    if (
      !isTailscaleIPv4(address) &&
      !(options.address.allowLoopback === true && address === "127.0.0.1")
    ) {
      await close();
      return fail(
        `The Hermes MCP listener did not start: ${address} is not a Tailscale address, and it binds no other`,
      );
    }
    if (current?.address === address && current.port === wanted.port) return state;
    await close();
    try {
      await readToken();
    } catch (error) {
      return fail(`The Hermes MCP listener did not start: ${(error as Error).message}`);
    }
    try {
      current = { server: await listen(address, wanted.port), address, port: wanted.port };
    } catch (error) {
      return fail(
        `The Hermes MCP listener did not start on ${address}:${wanted.port}: ${(error as Error).message}`,
      );
    }
    state = { state: "listening", url: `http://${address}:${wanted.port}/mcp` };
    host.log.info("The Hermes MCP listener is listening", { url: state.url });
    return state;
  };

  let queue: Promise<unknown> = Promise.resolve();
  /** One check at a time, so two never open two servers. */
  const sync = (): Promise<McpListenerState> => {
    const run = queue.then(apply);
    queue = run.catch(() => undefined);
    return run;
  };
  // Checks the settings now, so the Settings page shows the listener at once.
  host.routes.get("/mcp", async (c) => c.json(await sync()));
  return { sync };
}
