import { join } from "node:path";
import { BridgeKey } from "@pi-spore/mod-bridge/server";
import type { JobTimer, ServerModule } from "@pi-spore/module-api";
import Type from "typebox";
import { setupChat } from "./chat.js";
import { createConnector } from "./client.js";
import { HermesKey } from "./contract.js";
import { createControls } from "./controls.js";
import { setupHandoffs } from "./handoffs.js";
import { setupInbound } from "./inbound.js";
import { expandHome } from "./key.js";
import { findTailscaleAddress, type McpAddress, setupMcpListener } from "./mcp/listener.js";

export * from "./contract.js";

/** Between checks while Hermes is ready or the connector is off. Off reads settings only, so it sends nothing. */
const STEADY_POLL_MS = 60_000;
/** The first wait after a failed check; it doubles up to `MAX_BACKOFF_MS`. */
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

export interface HermesModuleOptions {
  /** Schedules the status poll and request timeouts. Tests pass a fake to run them by hand. */
  timer?: JobTimer;
  /** How long one request may wait for Hermes's answer (for a stream: its headers). */
  timeoutMs?: number;
  /** Where the MCP listener binds. Default: the desktop's Tailscale address, read from the network interfaces. */
  mcpAddress?: McpAddress;
}

// Timers are unref'd: an open poll or request never keeps the process up. A shutdown ends the process, which closes
// any open SSE stream, so the module needs no stop hook.
const realTimer: JobTimer = (run, ms) => {
  const handle = setTimeout(() => void run(), ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/**
 * The Hermes connector (ADR 0202, card Hermes 1.1): the one client other modules reach through `HermesKey`. Off by
 * default; off, it sends no request at all. It holds no key: `hermes.keyFile` names a file it reads on each call.
 */
export function createHermesModule(options: HermesModuleOptions = {}): ServerModule {
  const timer = options.timer ?? realTimer;
  return {
    id: "hermes",
    // The handoffs deliver results to chats, put controls on Home, and name the workspace and project (card 1.2).
    // Requests from Hermes skip the workspaces of runs (card 1.3).
    requires: ["agents", "attention", "workspaces", "projects", "bridge", "runs"],
    core: false,
    setup(host) {
      const keys = {
        enabled: host.settings.declare({
          key: "hermes.enabled",
          schema: Type.Boolean(),
          default: false,
          scope: "global",
        }),
        url: host.settings.declare({
          key: "hermes.url",
          // An origin only: a host name, an IPv4 or a bracketed IPv6 address, and a port. Anything else (a path,
          // user info, a query, a backslash that URL parsing reads as a path) would move the /p/<profile> paths.
          schema: Type.String({
            pattern:
              "^https?://([A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*|\\[[0-9A-Fa-f:.]+\\])(:[0-9]{1,5})?$",
          }),
          default: "http://hermes-docker:8642",
          scope: "global",
        }),
        profile: host.settings.declare({
          key: "hermes.profile",
          schema: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
          default: "pi-spore",
          scope: "global",
        }),
        // null: `<pi-spore home>/hermes/<profile>.key`, which is `~/.pi-spore/hermes/pi-spore.key` by default.
        keyFile: host.settings.declare({
          key: "hermes.keyFile",
          schema: Type.Union([Type.Null(), Type.String({ minLength: 1 })]),
          default: null,
          scope: "global",
        }),
      };

      const connector = createConnector({
        log: host.log,
        now: host.now,
        timer,
        timeoutMs: options.timeoutMs ?? 10_000,
        config: async () => {
          const resolved = await host.settings.resolve();
          const profile = resolved.get(keys.profile).value;
          const keyFile = resolved.get(keys.keyFile).value;
          return {
            enabled: resolved.get(keys.enabled).value,
            url: resolved.get(keys.url).value,
            profile,
            keyFile:
              keyFile === null
                ? join(host.home.root, "hermes", `${profile}.key`)
                : expandHome(keyFile),
          };
        },
      });
      host.provide(HermesKey, connector);
      const flags = {
        profile: async () => (await host.settings.resolve()).get(keys.profile).value,
        enabled: async () => (await host.settings.resolve()).get(keys.enabled).value,
      };
      // Handoffs and chat runs share one store and one answer path for approvals and clarify.
      const controls = createControls(host, connector);
      // Hermes to Pi through the MCP listener (card 1.3); the bridge's reply route answers its requests.
      const inbound = setupInbound(host, flags);
      host.use(BridgeKey).setHermesAsker({
        ...setupHandoffs(host, connector, controls, flags),
        reply: inbound.reply,
      });
      setupChat(host, connector, controls, { enabled: flags.enabled, timer });
      const listener = setupMcpListener(host, inbound, {
        address: options.mcpAddress ?? { lookup: findTailscaleAddress },
        enabled: flags.enabled,
      });

      let failures = 0;
      const poll = async () => {
        // The listener follows its settings at each check, so turning one off closes it without a restart.
        await listener
          .sync()
          .catch((error: unknown) =>
            host.log.error("The Hermes MCP listener check failed", { error: String(error) }),
          );
        try {
          const status = await connector.refresh();
          failures = status.state === "ready" || status.state === "disabled" ? 0 : failures + 1;
        } catch (error) {
          failures += 1;
          host.log.error("The Hermes status check failed", { error: String(error) });
        }
        timer(
          poll,
          failures === 0
            ? STEADY_POLL_MS
            : Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (failures - 1)),
        );
      };
      host.onStarted(() => {
        timer(poll, 0);
      });

      host.routes.get("/status", async (c) => c.json(await connector.status()));
      // Reload on the Settings page: check now, not at the next poll.
      host.routes.post("/refresh", async (c) => c.json(await connector.refresh()));
    },
  };
}

export const hermesModule = createHermesModule();
