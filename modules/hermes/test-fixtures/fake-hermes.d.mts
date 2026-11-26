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
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
}

export interface FakeRun {
  run_id: string;
  status: string;
  admission_id: string;
  execution_generation: number;
  session_id: string | undefined;
}

export interface FakeHermes {
  url: string;
  options: FakeHermesOptions;
  requests: FakeRequest[];
  addSession(id: string, source: string): void;
  finish(runId: string, output: string): void;
  emit(runId: string, data: Record<string, unknown>): void;
  requestApproval(runId: string, promptId: string): void;
  requestClarify(runId: string, promptId: string): void;
  run(runId: string): FakeRun | undefined;
  restart(): void;
  release(): void;
  close(): Promise<void>;
}

export function startFakeHermes(options: { key: string; profile?: string }): Promise<FakeHermes>;
