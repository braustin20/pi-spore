import { ApiError, type JobTimer, type Logger } from "@pi-spore/module-api";
import { type HermesStatus, parse, ValidationError } from "@pi-spore/shared";
import type { Static, TSchema } from "typebox";
import type { Hermes, RunEventFrame } from "./contract.js";
import { readKey } from "./key.js";
import {
  KNOWN_EVENTS,
  RunEvent,
  type SseFrame,
  sseFrames,
  TERMINAL_EVENTS,
} from "./protocol/events.js";
import {
  ApprovalAnswer,
  Capabilities,
  ClarifyAnswer,
  CreateSessionBody,
  ErrorBody,
  Health,
  Models,
  ResolveUnknownBody,
  Run,
  RunAdmission,
  RunControlAnswer,
  SessionCreated,
  SessionList,
  SessionMessages,
  StartRunBody,
} from "./protocol/schemas.js";

export interface HermesConfig {
  enabled: boolean;
  /** `http(s)://host:port`, no path. */
  url: string;
  profile: string;
  /** Absolute after `~` expansion; checked when the key is read. */
  keyFile: string;
}

/** The minor version this client was tested on (spike Hermes 0.2, card Hermes 0.4). */
export const TESTED_VERSION = { major: 0, minor: 23 };

type Features = Capabilities["features"];
/** Spike Q1: the flags of the session-authority path that the connector codes for. */
const REQUIRED_FLAGS: readonly [string, (features: Features) => boolean | undefined][] = [
  ["run_submission", (f) => f.run_submission],
  ["run_status", (f) => f.run_status],
  ["run_events_sse", (f) => f.run_events_sse],
  ["run_stop", (f) => f.run_stop],
  ["run_approval_response", (f) => f.run_approval_response],
  ["approval_events", (f) => f.approval_events],
  ["session_resources", (f) => f.session_resources],
  ["run_unknown_resolution", (f) => f.run_unknown_resolution],
  ["runs_idempotency.supported", (f) => f.runs_idempotency?.supported],
  ["runs_idempotency.durable", (f) => f.runs_idempotency?.durable],
];

export interface ConnectorOptions {
  /** Read on every call, so a settings change applies at once. */
  config: () => Promise<HermesConfig>;
  log: Logger;
  now: () => number;
  /** Arms request timeouts. Tests pass a fake to fire them. */
  timer: JobTimer;
  timeoutMs: number;
}

export interface Connector extends Hermes {
  /** Checks Hermes again now (one request each to health, capabilities, and models), unless it is off. */
  refresh(): Promise<HermesStatus>;
}

const UNREACHABLE = new Set(["hermes_unreachable", "hermes_timeout", "hermes_unavailable"]);
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

interface SendOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** `/health` needs no key. */
  auth?: boolean;
  /** Ends the request, or the stream after its headers, when it aborts. */
  signal?: AbortSignal;
}

const turnedOff = (what: string) =>
  new ApiError(503, "hermes_not_ready", `Hermes was turned off; ${what} is closed`);

/** Outbound HTTP and SSE to `<url>/p/<profile>` (ADR 0202 decision 4). Opens no listener. */
export function createConnector(options: ConnectorOptions): Connector {
  const { log, timeoutMs } = options;
  const unknownEvents = new Set<string>();

  /** Sends one request and returns the answer once its headers are in. A non-2xx answer throws. */
  const send = async (
    config: HermesConfig,
    method: string,
    path: string,
    { body, headers = {}, auth = true, signal }: SendOptions = {},
    readBody = true,
  ): Promise<{ response: Response; text: string }> => {
    const what = `${method} ${path}`;
    const all: Record<string, string> = { accept: "application/json", ...headers };
    if (auth) {
      try {
        all.authorization = `Bearer ${await readKey(config.keyFile)}`;
      } catch (error) {
        throw new ApiError(503, "hermes_key_file", (error as Error).message);
      }
    }
    if (body !== undefined) all["content-type"] = "application/json";
    const controller = new AbortController();
    const cancel = options.timer(async () => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.url}/p/${config.profile}${path}`, {
        method,
        headers: all,
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = readBody || !response.ok ? await response.text() : "";
      if (!response.ok) throw failure(config, what, response.status, text);
      return { response, text };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw turnedOff(what);
      if (controller.signal.aborted)
        throw new ApiError(
          502,
          "hermes_timeout",
          `Hermes at ${config.url} did not answer ${what} in ${timeoutMs} ms`,
        );
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new ApiError(
        502,
        "hermes_unreachable",
        `Hermes at ${config.url} did not answer ${what}: ${cause ?? (error as Error).message}`,
      );
    } finally {
      cancel();
    }
  };

  const failure = (config: HermesConfig, what: string, status: number, text: string) => {
    if (status === 401 || status === 403)
      return new ApiError(
        502,
        "hermes_unauthorized",
        `Hermes refused the key in ${config.keyFile} (${status} on ${what})`,
      );
    if (status >= 500)
      return new ApiError(502, "hermes_unavailable", `Hermes answered ${status} to ${what}`);
    let body: Static<typeof ErrorBody> | undefined;
    try {
      body = parse(ErrorBody, JSON.parse(text), "Hermes error");
    } catch {
      body = undefined;
    }
    const code = body?.error.code ?? `http_${status}`;
    const passed = status === 400 || status === 404 || status === 409 ? status : 502;
    return new ApiError(
      passed,
      `hermes_${code}`,
      `Hermes refused ${what} (${status} ${code})${body?.error.message ? `: ${body.error.message}` : ""}`,
    );
  };

  const answer = <S extends TSchema>(schema: S, text: string, what: string): Static<S> => {
    try {
      return parse(schema, JSON.parse(text), `Hermes answer to ${what}`);
    } catch (error) {
      const message =
        error instanceof ValidationError ? error.message : `Hermes answer to ${what} is not JSON`;
      throw new ApiError(502, "hermes_bad_response", message);
    }
  };

  const call = async <S extends TSchema>(
    config: HermesConfig,
    schema: S,
    method: string,
    path: string,
    sendOptions?: SendOptions,
  ): Promise<Static<S>> =>
    answer(schema, (await send(config, method, path, sendOptions)).text, `${method} ${path}`);

  const check = async (config: HermesConfig): Promise<HermesStatus> => {
    const checkedAt = options.now();
    const fail = (
      state: "unreachable" | "unauthorized" | "incompatible",
      detail: string,
    ): HermesStatus => ({ state, detail, checkedAt });
    try {
      const { version } = await call(config, Health, "GET", "/health", { auth: false });
      const match = /^(\d+)\.(\d+)(\.|$)/.exec(version);
      if (
        Number(match?.[1]) !== TESTED_VERSION.major ||
        Number(match?.[2]) !== TESTED_VERSION.minor
      ) {
        const tested = `${TESTED_VERSION.major}.${TESTED_VERSION.minor}.x`;
        return fail(
          "incompatible",
          `Hermes ${version} is not tested; pi-spore is tested on Hermes ${tested}`,
        );
      }
      const { features } = await call(config, Capabilities, "GET", "/v1/capabilities");
      const missing = REQUIRED_FLAGS.filter(([, flag]) => flag(features) !== true).map(
        ([name]) => name,
      );
      if (missing.length > 0)
        return fail(
          "incompatible",
          `Hermes lacks required capability flags: ${missing.join(", ")}`,
        );
      const models = await call(config, Models, "GET", "/v1/models");
      if (!models.data.some((model) => model.id === config.profile))
        return fail("incompatible", `Hermes /v1/models does not list the model ${config.profile}`);
      return {
        state: "ready",
        version,
        url: config.url,
        profile: config.profile,
        checkedAt,
      };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "hermes_unauthorized" || error.code === "hermes_key_file")
        return fail("unauthorized", error.message);
      if (UNREACHABLE.has(error.code)) return fail("unreachable", error.message);
      return fail("incompatible", error.message);
    }
  };

  const configKey = (config: HermesConfig) =>
    JSON.stringify([config.url, config.profile, config.keyFile]);
  let cached: { key: string; status: HermesStatus } | undefined;
  let running: { key: string; promise: Promise<HermesStatus> } | undefined;
  /** Open event streams. Turning Hermes off closes them, so off means no connection at all. */
  const streams = new Set<AbortController>();

  const refreshWith = (config: HermesConfig): Promise<HermesStatus> => {
    if (!config.enabled) {
      cached = undefined;
      for (const stream of streams) stream.abort();
      return Promise.resolve({ state: "disabled" });
    }
    const key = configKey(config);
    if (running?.key === key) return running.promise;
    const promise: Promise<HermesStatus> = check(config)
      .then((status) => {
        if (cached?.status.state !== status.state)
          log.info("Hermes connector status", {
            state: status.state,
            ...("detail" in status ? { detail: status.detail } : {}),
          });
        cached = { key, status };
        return status;
      })
      .finally(() => {
        // A check for another config may have started since; it stays the one to join.
        if (running?.promise === promise) running = undefined;
      });
    running = { key, promise };
    return promise;
  };

  const cachedFor = (config: HermesConfig) =>
    config.enabled && cached?.key === configKey(config) ? cached.status : undefined;

  const status = async (): Promise<HermesStatus> => {
    const config = await options.config();
    return cachedFor(config) ?? (await refreshWith(config));
  };

  /** The config a call uses, read once, so the check and the request go to the same Hermes. */
  const ready = async (): Promise<HermesConfig> => {
    const config = await options.config();
    const known = cachedFor(config);
    // A cached failure may be old: check again before refusing, so a call works as soon as Hermes is back.
    const now = known?.state === "ready" ? known : await refreshWith(config);
    if (now.state === "ready") return config;
    throw new ApiError(
      503,
      "hermes_not_ready",
      now.state === "disabled"
        ? "Hermes is off; set hermes.enabled to true"
        : `Hermes is ${now.state}: ${now.detail}`,
    );
  };

  const runPath = (id: string, rest = "") => `/v1/runs/${encodeURIComponent(id)}${rest}`;
  const query = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(values))
      if (value !== undefined) params.set(name, String(value));
    const text = params.toString();
    return text === "" ? "" : `?${text}`;
  };

  async function* runEvents(id: string, lastEventId?: string): AsyncGenerator<RunEventFrame> {
    const config = await ready();
    const path = runPath(id, "/events");
    const stream = new AbortController();
    streams.add(stream);
    try {
      const { response } = await send(
        config,
        "GET",
        path,
        {
          headers: {
            accept: "text/event-stream",
            ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
          },
          signal: stream.signal,
        },
        false,
      );
      if (!response.body) throw new ApiError(502, "hermes_bad_response", `GET ${path} has no body`);
      let last = lastEventId;
      // Closing the generator, by the end or by a caller that stops reading, cancels the body.
      const frames = sseFrames(response.body);
      try {
        while (true) {
          let next: IteratorResult<SseFrame>;
          try {
            next = await frames.next();
          } catch {
            next = { done: true, value: undefined };
          }
          if (stream.signal.aborted) throw turnedOff(`the event stream of run ${id}`);
          if (next.done)
            throw new ApiError(
              502,
              "hermes_stream_lost",
              `The event stream of run ${id} ended before the run did; resume after event ${last ?? "none"} or read the run`,
            );
          const frame = next.value;
          if (frame.id !== undefined) last = frame.id;
          const event = eventOf(id, frame.data);
          if (event === undefined) continue;
          yield { id: frame.id, event };
          if (TERMINAL_EVENTS.has(event.event)) return;
        }
      } finally {
        await frames.return(undefined);
      }
    } finally {
      streams.delete(stream);
    }
  }

  /** The checked event of one frame, or undefined for an event name pi-spore does not know. */
  const eventOf = (id: string, text: string): RunEvent | undefined => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(502, "hermes_bad_response", `An event of run ${id} is not JSON`);
    }
    const name = (data as { event?: unknown } | null)?.event;
    if (typeof name !== "string")
      throw new ApiError(502, "hermes_bad_response", `An event of run ${id} has no event name`);
    if (!KNOWN_EVENTS.has(name)) {
      if (!unknownEvents.has(name)) {
        unknownEvents.add(name);
        log.info("Hermes sent an unknown event; skipped", { event: name });
      }
      return undefined;
    }
    try {
      return parse(RunEvent, data, `Hermes event ${name}`);
    } catch (error) {
      throw new ApiError(502, "hermes_bad_response", (error as Error).message);
    }
  };

  return {
    refresh: async () => refreshWith(await options.config()),
    status,
    async startRun(body, idempotencyKey) {
      const checked = parse(StartRunBody, body, "Hermes run body");
      if (!IDEMPOTENCY_KEY.test(idempotencyKey))
        throw new ValidationError("An Idempotency-Key is 1 to 255 visible ASCII characters");
      const config = await ready();
      // Fixed key order, so a retry of the same fields is the identical body Hermes compares.
      return await call(config, RunAdmission, "POST", "/v1/runs", {
        body: { input: checked.input, session_id: checked.session_id },
        headers: { "idempotency-key": idempotencyKey },
      });
    },
    getRun: async (id) => call(await ready(), Run, "GET", runPath(id)),
    runEvents,
    stop: async (id) => call(await ready(), RunControlAnswer, "POST", runPath(id, "/stop")),
    async answerApproval(id, body) {
      const checked = parse(ApprovalAnswer, body, "Hermes approval answer");
      await send(await ready(), "POST", runPath(id, "/approval"), {
        body: {
          request_id: checked.request_id,
          execution_generation: checked.execution_generation,
          choice: checked.choice,
        },
      });
    },
    async answerClarify(id, body) {
      const checked = parse(ClarifyAnswer, body, "Hermes clarify answer");
      await send(await ready(), "POST", runPath(id, "/clarify"), {
        body: {
          request_id: checked.request_id,
          execution_generation: checked.execution_generation,
          answer: checked.answer,
        },
      });
    },
    async resolveUnknown(id, body) {
      const checked = parse(ResolveUnknownBody, body, "Hermes resolve-unknown body");
      return await call(await ready(), RunControlAnswer, "POST", runPath(id, "/resolve-unknown"), {
        body: {
          admission_id: checked.admission_id,
          execution_generation: checked.execution_generation,
        },
      });
    },
    async createSession(body) {
      const checked = parse(CreateSessionBody, body, "Hermes session body");
      const created = await call(await ready(), SessionCreated, "POST", "/api/sessions", {
        body: checked,
      });
      return created.session;
    },
    listSessions: async (filter = {}) =>
      call(await ready(), SessionList, "GET", `/api/sessions${query(filter)}`),
    sessionMessages: async (id, filter = {}) =>
      call(
        await ready(),
        SessionMessages,
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/messages${query(filter)}`,
      ),
  };
}
