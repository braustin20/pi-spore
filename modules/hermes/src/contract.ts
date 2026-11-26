import { defineInterface } from "@pi-spore/module-api";
import type { HermesStatus } from "@pi-spore/shared";
import type { RunEvent } from "./protocol/events.js";
import type {
  ApprovalAnswer,
  ClarifyAnswer,
  CreateSessionBody,
  ResolveUnknownBody,
  Run,
  RunAdmission,
  RunControlAnswer,
  Session,
  SessionList,
  SessionMessages,
  StartRunBody,
} from "./protocol/schemas.js";

export type { RunEvent } from "./protocol/events.js";
export type {
  ApprovalAnswer,
  ClarifyAnswer,
  CreateSessionBody,
  ResolveUnknownBody,
  Run,
  RunAdmission,
  RunControlAnswer,
  Session,
  SessionList,
  SessionMessages,
  StartRunBody,
} from "./protocol/schemas.js";

/** One SSE frame. Resume a lost stream by passing the last `id` seen to `runEvents`. */
export interface RunEventFrame {
  id: string | undefined;
  event: RunEvent;
}

/**
 * The one Hermes client (ADR 0202 decision 4). Every call except `status` refuses with 503 `hermes_not_ready` unless
 * the status is `ready`, so with `hermes.enabled` off nothing reaches Hermes. Hermes's errors come back as `ApiError`
 * with code `hermes_<code>`, such as `hermes_idempotency_key_conflict` or `hermes_permission_denied`; a timeout is
 * `hermes_timeout`, and nothing is sent again on its own.
 */
export interface Hermes {
  status(): Promise<HermesStatus>;
  /**
   * Admits a run. Hermes replays the first answer for the same key and body for 24 h, so after a timeout the caller
   * sends the identical body with the same key. A changed body under a used key is 409. No provider or model goes in
   * the body: Hermes's own routing decides.
   */
  startRun(body: StartRunBody, idempotencyKey: string): Promise<RunAdmission>;
  getRun(id: string): Promise<Run>;
  /**
   * Follows the run's events until a terminal one. A stream that ends early throws 502 `hermes_stream_lost`; resume
   * with the last frame id, or read `getRun` (after a Hermes restart the stream is gone: 404 `hermes_run_not_found`).
   * A `replay.truncated` frame means older events are lost.
   */
  runEvents(id: string, lastEventId?: string): AsyncIterable<RunEventFrame>;
  stop(id: string): Promise<RunControlAnswer>;
  /** Only the user picks the answer. `choice` is `once` or `deny`; the boundary refuses anything else. */
  answerApproval(id: string, answer: ApprovalAnswer): Promise<void>;
  answerClarify(id: string, answer: ClarifyAnswer): Promise<void>;
  /** Clears a run cut off by a Hermes restart. Only on the user's pick, never on its own (ADR 0202 decision 6). */
  resolveUnknown(id: string, body: ResolveUnknownBody): Promise<RunControlAnswer>;
  createSession(body: CreateSessionBody): Promise<Session>;
  listSessions(query?: { source?: string; limit?: number; offset?: number }): Promise<SessionList>;
  sessionMessages(
    id: string,
    query?: { limit?: number; offset?: number; order?: "oldest" | "latest" },
  ): Promise<SessionMessages>;
}

export const HermesKey = defineInterface<Hermes>("hermes", "client");
