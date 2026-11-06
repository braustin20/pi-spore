import { type ApiClient, ApiRequestError } from "@pi-spore/module-api";

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
  return {
    get: async (path) => readAnswer(await fetch(`/api/${path}`, { headers: auth })),
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
