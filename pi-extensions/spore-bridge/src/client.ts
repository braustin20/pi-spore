import Type, { type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

/** How the extension finds the server: set by pi-spore on every agent process (architecture 2). */
export interface BridgeEnv {
  url: string;
  token: string;
}

/** Reads `PI_SPORE_URL` and `PI_SPORE_TOKEN`, or names the one that is missing. */
export function bridgeEnv(env: Readonly<Record<string, string | undefined>>): BridgeEnv {
  const url = env.PI_SPORE_URL;
  const token = env.PI_SPORE_TOKEN;
  if (!url)
    throw new Error("spore-bridge runs only inside pi-spore agents: PI_SPORE_URL is not set");
  if (!token)
    throw new Error("spore-bridge runs only inside pi-spore agents: PI_SPORE_TOKEN is not set");
  return { url: url.replace(/\/+$/, ""), token };
}

export const RunStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);

export const Run = Type.Object({
  id: Type.String(),
  action: Type.String(),
  status: RunStatus,
  exitCode: Type.Optional(Type.Integer()),
  signal: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
export type Run = Static<typeof Run>;

export const RunAnswer = Type.Object({ run: Run });
export const LogAnswer = Type.Object({
  run: Run,
  text: Type.String(),
  truncated: Type.Boolean(),
});
export const QuestionAnswer = Type.Object({ question: Type.Object({ id: Type.String() }) });

const ErrorBody = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});

/** An error the model should read: what failed and what the server said. */
export class BridgeError extends Error {
  override name = "BridgeError";
}

/** Calls the bridge routes (`/api/bridge/...`) with the agent's token. */
export class BridgeClient {
  constructor(
    private readonly env: BridgeEnv,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * GET, or POST with a JSON body. A POST with `receipt` sends it as the Idempotency-Key, so a replayed tool call
   * gets the first answer (R16.3).
   */
  async call<const S extends TSchema>(
    schema: S,
    path: string,
    options: { body?: unknown; receipt?: string; signal?: AbortSignal } = {},
  ): Promise<Static<S>> {
    const post = options.body !== undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.env.url}/api/bridge/${path}`, {
        method: post ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.env.token}`,
          ...(post ? { "content-type": "application/json" } : {}),
          ...(options.receipt ? { "idempotency-key": options.receipt } : {}),
        },
        ...(post ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new BridgeError(
        `The pi-spore server at ${this.env.url} did not answer: ${(error as Error).message}`,
      );
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new BridgeError(`pi-spore sent a non-JSON answer (${response.status}) to ${path}`);
    }
    if (!response.ok) {
      const detail = Check(ErrorBody, body) ? `${body.error.message} (${body.error.code})` : text;
      throw new BridgeError(`pi-spore refused ${path}: ${detail}`);
    }
    if (!Check(schema, body)) {
      const why = Errors(schema, body)
        .slice(0, 3)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`)
        .join("; ");
      throw new BridgeError(`pi-spore sent an unexpected answer to ${path}: ${why}`);
    }
    return body;
  }
}
