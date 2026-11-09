import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { JobTimer } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { parse, UsagePlansResponse } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakePipelines } from "./fake-pipelines.js";
import { createUsageModule } from "./server.js";

const START = 1_800_000_000_000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN = "test-token-xyz";
const ACCOUNT = "acct-1";
/** What the module schedules between polls (ADR 0153). */
const POLL_MS = 60_000;

/** A reset time this far ahead of the test clock, so no window reads as stale. The endpoint gives epoch seconds. */
const resetIn = (ms: number) => Math.round((START + ms) / 1000);

/** ChatGPT's usage body as a Plus plan answers it: a full 5-hour window and a weekly one at 27%. */
const WHAM_BODY = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 18_000,
      reset_at: resetIn(3 * 60 * 60_000),
    },
    secondary_window: {
      used_percent: 27,
      limit_window_seconds: 604_800,
      reset_at: resetIn(3 * 24 * 60 * 60_000),
    },
  },
  additional_rate_limits: [],
};

interface Answer {
  status: number;
  body: unknown;
}
const OK: Answer = { status: 200, body: WHAM_BODY };

// The test clock ticks once per call, so a delay is a few ms short of the one the module asked for.
const wholeSeconds = (ms: number) => Math.round(ms / 1000) * 1000;

let server: TestServer;
let scratch: string;
let codexHome: string;
let authFile: string;
let timers: { run: () => Promise<void>; ms: number; cancelled: boolean }[];
let requests: { url: string; headers: Headers }[];
/** Answers the fake fetch hands out, in order; the last one keeps answering. */
let answers: Answer[];

const timer: JobTimer = (run, ms) => {
  const entry = { run, ms, cancelled: false };
  timers.push(entry);
  return () => {
    entry.cancelled = true;
  };
};

const fakeFetch: typeof fetch = async (input, init) => {
  requests.push({ url: String(input), headers: new Headers(init?.headers) });
  const answer = answers[Math.min(requests.length - 1, answers.length - 1)] ?? OK;
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
};

/** A Codex CLI login, with the keys pi-spore does not read. */
function writeCodexLogin() {
  writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id-token",
        access_token: TOKEN,
        refresh_token: "refresh-token-abc",
        account_id: ACCOUNT,
      },
      last_refresh: "2026-11-08T00:00:00Z",
    }),
  );
}

async function start() {
  server = await createTestServer(
    [
      fakePipelines().module,
      projectsModule,
      vcsGitModule,
      workspacesModule,
      createUsageModule({ codexHome, fetch: fakeFetch }),
    ],
    { startAt: START, timer },
  );
}

/** Waits for the poll the server runs at start: its delay of 0 needs no timer, and it schedules the next one. */
async function awaitFirstPoll() {
  const end = Date.now() + 5_000;
  while (scheduledDelays().length === 0) {
    if (Date.now() > end) throw new Error("Timed out waiting for a poll");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Runs every timer the runner scheduled, waits for each step to commit, and returns the delays it asked for. */
async function runDue(): Promise<number[]> {
  const due = timers.filter((entry) => !entry.cancelled);
  timers = [];
  for (const entry of due) await entry.run();
  return due.map((entry) => wholeSeconds(entry.ms));
}

const scheduledDelays = () =>
  timers.filter((entry) => !entry.cancelled).map((entry) => wholeSeconds(entry.ms));

/** The `/api/usage/plans` body and its raw JSON text. */
async function plans(): Promise<{ body: UsagePlansResponse; text: string }> {
  const response = await server.request("GET", "/api/usage/plans");
  const text = await response.text();
  expect(response.status).toBe(200);
  return { body: parse(UsagePlansResponse, JSON.parse(text), "plans"), text };
}

const codexWindow = (body: UsagePlansResponse, name: string) =>
  body.plans.find((plan) => plan.plan === "codex")?.windows.find((window) => window.name === name);

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-codex-")));
  codexHome = join(scratch, "codex-home");
  authFile = join(codexHome, "auth.json");
  mkdirSync(codexHome);
  writeCodexLogin();
  timers = [];
  requests = [];
  answers = [OK];
});
afterEach(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("polling Codex usage (ADR 0153)", () => {
  it("asks the usage endpoint with the Codex login and lists the plan windows", async () => {
    await start();
    await awaitFirstPoll();
    expect(requests[0]?.url).toBe(USAGE_URL);
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe(ACCOUNT);
    expect(requests[0]?.headers.get("user-agent")).toBe("codex-cli");
    expect(requests[0]?.headers.get("accept")).toBe("application/json");
    // The login folder is read only: nothing is written to it.
    expect(readdirSync(codexHome)).toEqual(["auth.json"]);

    const { body, text } = await plans();
    expect(body.plans.find((plan) => plan.plan === "codex")?.source).toBe("chatgpt wham/usage");
    expect(codexWindow(body, "5h")?.utilization).toBe(1);
    expect(codexWindow(body, "7d")?.utilization).toBe(0.27);
    expect(body.errors).toEqual([]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ACCOUNT);
  });

  it("shows a failed poll on /plans, keeps polling, and clears the error when a poll answers", async () => {
    answers = [{ status: 401, body: { detail: "invalid bearer token" } }, OK];
    await start();
    await awaitFirstPoll();

    const failed = await plans();
    expect(failed.body.errors).toHaveLength(1);
    expect(failed.body.errors[0]).toContain("HTTP 401");
    expect(failed.body.errors[0]).toContain('run "codex"');
    expect(failed.text).not.toContain(TOKEN);
    expect(failed.body.plans).toEqual([]);
    // The failed poll did not end the job.
    expect(scheduledDelays()).toEqual([POLL_MS]);

    await expect(runDue()).resolves.toEqual([POLL_MS]);
    expect(requests).toHaveLength(2);
    const healed = await plans();
    expect(codexWindow(healed.body, "7d")?.utilization).toBe(0.27);
    expect(healed.body.errors).toEqual([]);
    expect(healed.text).not.toContain(TOKEN);
  });

  it("names the login path when there is no Codex login, and keeps the job", async () => {
    rmSync(authFile);
    await start();
    await awaitFirstPoll();

    const { body } = await plans();
    expect(body.errors).toEqual([`Codex usage: No Codex login at ${authFile}; run "codex login"`]);
    expect(scheduledDelays()).toEqual([POLL_MS]);
  });

  it("schedules the next poll 60 seconds after each one", async () => {
    await start();
    await awaitFirstPoll();
    expect(scheduledDelays()).toEqual([POLL_MS]);
    expect(await runDue()).toEqual([POLL_MS]);
    expect(requests).toHaveLength(2);
    expect(scheduledDelays()).toEqual([POLL_MS]);
  });

  it("does not show the 401 answer's body", async () => {
    answers = [{ status: 500, body: { detail: "upstream token was test-token-xyz" } }, OK];
    await start();
    await awaitFirstPoll();
    const { body, text } = await plans();
    expect(body.errors[0]).toContain("HTTP 500");
    expect(text).not.toContain("upstream");
    expect(text).not.toContain(TOKEN);
  });
});
