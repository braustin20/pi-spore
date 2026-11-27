// Types of the FAKE Hermes in fake-hermes.mjs. Tests only.
import type { IncomingHttpHeaders } from "node:http";

export interface FakeHermesOptions {
  version: string;
  models: string[];
  missingFlag?: string;
  falseFlag?: string;
  serverError?: boolean;
  holdRuns?: boolean;
  holdAll?: boolean;
  dropStreamAfter?: number | undefined;
  loseAnswers?: boolean;
  blankSessionMeta?: boolean;
  queueRuns?: boolean;
  answers: Record<string, { status: number; raw: string }>;
}

export interface FakeRequest {
  method: string;
  path: string;
  /** The query string, with its `?`, or empty. */
  search: string;
  headers: IncomingHttpHeaders;
  raw: string;
}

export interface FakeRun {
  run_id: string;
  status: string;
  admission_id: string;
  execution_generation: number | null;
  session_id: string | undefined;
}

export interface FakeHermes {
  url: string;
  options: FakeHermesOptions;
  requests: FakeRequest[];
  addSession(id: string, source: string): void;
  finish(runId: string, output: string): void;
  emit(runId: string, data: Record<string, unknown>): void;
  emitRaw(runId: string, raw: string): void;
  requestApproval(runId: string, promptId: string): void;
  requestClarify(runId: string, promptId: string): void;
  run(runId: string): FakeRun | undefined;
  startQueued(runId: string): void;
  setSessionMeta(id: string, meta: { model: string; billing_provider: string }): void;
  restart(): void;
  release(): void;
  close(): Promise<void>;
}

export function startFakeHermes(options: { key: string; profile?: string }): Promise<FakeHermes>;
