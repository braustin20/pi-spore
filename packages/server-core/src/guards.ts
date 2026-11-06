const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The host name of a Host header or URL authority, without the port. Keeps IPv6 brackets. */
function hostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

/** DNS rebinding guard: a web page can point its own domain at 127.0.0.1, but its requests then carry that domain. */
export function isLoopbackHost(host: string | undefined): boolean {
  return LOOPBACK_HOSTS.has(hostname(host) ?? "");
}

/** Browsers send Origin on WebSocket upgrades. A page from any other site must not open one. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}
