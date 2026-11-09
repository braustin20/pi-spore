const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The hosts `tailscale serve` may forward from, and the Tailscale logins it may forward for (ADR 0143). */
export interface RemoteAccess {
  allowedHosts: readonly string[];
  allowedLogins: readonly string[];
}

interface Refusal {
  status: 401 | 403;
  code: "bad_peer" | "bad_host" | "identity_required" | "bad_origin";
  message: string;
}

/** The host name of a Host header or URL authority, without the port. Keeps IPv6 brackets. */
function hostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

/** DNS rebinding guard: a web page can point its own domain at 127.0.0.1, but its requests then carry that domain. */
export function isLoopbackHost(host: string | undefined): boolean {
  return LOOPBACK_HOSTS.has(hostname(host) ?? "");
}

function isAllowedHost(host: string | undefined, access: RemoteAccess): boolean {
  const name = hostname(host)?.toLowerCase();
  return access.allowedHosts.some((allowed) => allowed.toLowerCase() === name);
}

/** Browsers send Origin on WebSocket upgrades. A page from any other site must not open one. */
function isAllowedOrigin(origin: string | undefined, access: RemoteAccess): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackHost(url.host)) return true;
  // tailscale serve answers only on HTTPS at the default port; URL drops ":443" for https.
  return url.protocol === "https:" && url.port === "" && isAllowedHost(url.host, access);
}

/**
 * Decides whether a request may reach pi-spore at all, before the token check. The server binds loopback only, so a
 * remote request arrives through `tailscale serve` on this machine: it keeps the tailnet Host and sets an unforgeable
 * Tailscale-User-Login. `origin` is checked only for WebSocket upgrades, where browsers skip same-origin rules.
 */
export function guardRequest(
  access: RemoteAccess,
  request: { host: string | undefined; peer: string | undefined; login: string | undefined },
  upgrade?: { origin: string | undefined },
): Refusal | undefined {
  // A peer from another machine bypassed tailscale serve, so its login header could be forged.
  if (!LOOPBACK_PEERS.has(request.peer ?? "")) {
    return { status: 403, code: "bad_peer", message: "pi-spore answers only loopback peers" };
  }
  if (!isLoopbackHost(request.host)) {
    if (!isAllowedHost(request.host, access)) {
      return {
        status: 403,
        code: "bad_host",
        message: "pi-spore answers only on loopback hosts and server.allowedHosts",
      };
    }
    if (!access.allowedLogins.some((login) => login === request.login)) {
      return {
        status: 401,
        code: "identity_required",
        message:
          "This Tailscale login is missing or not allowed; add it to server.allowedLogins in ~/.pi-spore/settings.json",
      };
    }
  }
  if (upgrade && !isAllowedOrigin(upgrade.origin, access)) {
    return { status: 403, code: "bad_origin", message: "pi-spore refuses pages from other sites" };
  }
  return undefined;
}
