import { type ApiClient, ApiRequestError } from "@pi-spore/module-api";
import { EventSocket } from "./socket.js";

function tokenFromPage(): string | undefined {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="pi-spore-token"]')?.content || undefined
  );
}

async function readAnswer(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiRequestError(
      response.status,
      "bad_response",
      `Server sent non-JSON (${response.status})`,
    );
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `Server answered ${response.status}`,
    );
  }
  return body;
}

export function createApiClient(): ApiClient {
  const token = tokenFromPage();
  const auth: Record<string, string> = token ? { "x-pi-spore-token": token } : {};
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  // In Vite dev the page has no token; the dev proxy adds it to the socket URL.
  const socketUrl = (path: string) =>
    `${scheme}//${window.location.host}/api/${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const socket = new EventSocket(socketUrl("ws"));
  return {
    subscribe: (topic, onEvent) => socket.subscribe(topic, onEvent),
    socketUrl,
    get: async (path) => readAnswer(await fetch(`/api/${path}`, { headers: auth })),
    getBlob: async (path) => {
      const response = await fetch(`/api/${path}`, { headers: auth });
      if (!response.ok) await readAnswer(response);
      return response.blob();
    },
    send: async (method, path, body) =>
      readAnswer(
        await fetch(`/api/${path}`, {
          method,
          headers: {
            ...auth,
            "idempotency-key": crypto.randomUUID(),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
  };
}
