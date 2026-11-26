import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { type Agents, AgentsKey, createAgentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { bridgeModule } from "@pi-spore/mod-bridge/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { JobTimer, Logger, ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { type FakeHermes, startFakeHermes } from "../test-fixtures/fake-hermes.mjs";
import { createHermesModule, type Hermes, HermesKey } from "./server.js";

export const TIMEOUT_MS = 10_000;

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

/** A timer that runs nothing on its own. A test fires what is pending, so no test waits on a clock. */
export function fakeTimer() {
  const pending = new Set<{ run: () => Promise<void>; ms: number }>();
  const timer: JobTimer = (run, ms) => {
    const entry = { run, ms };
    pending.add(entry);
    return () => pending.delete(entry);
  };
  return {
    timer,
    /** Delays of the timers armed now, in the order they were armed. */
    delays: () => [...pending].map((entry) => entry.ms),
    /** Runs the oldest pending timer of this delay, and waits for it. */
    async fireOne(ms: number) {
      const entry = [...pending].find((candidate) => candidate.ms === ms);
      if (!entry) throw new Error(`no timer of ${ms} ms is pending`);
      pending.delete(entry);
      await entry.run();
    },
    /** Runs every pending timer once, whatever its delay, and waits for them. */
    async fireAll() {
      const due = [...pending];
      pending.clear();
      await Promise.all(due.map((entry) => entry.run()));
    },
    /** Runs every pending timer of this delay once, and waits for them. */
    async fire(ms: number) {
      const due = [...pending].filter((entry) => entry.ms === ms);
      for (const entry of due) pending.delete(entry);
      await Promise.all(due.map((entry) => entry.run()));
    },
  };
}

export interface LogLine {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface Harness {
  server: TestServer;
  fake: FakeHermes;
  hermes: Hermes;
  agents: Agents;
  key: string;
  keyFile: string;
  log: LogLine[];
  timers: ReturnType<typeof fakeTimer>;
  /** The job runner's timer: delayed job steps (the handoff backoff) wait here until a test fires them. */
  jobTimers: ReturnType<typeof fakeTimer>;
  /** Writes `<home>/settings.json`. Settings are read fresh on every call. */
  settings(values: Record<string, unknown>): void;
  /** `keepFake` leaves the FAKE Hermes up, for a second harness that plays pi-spore after a restart. */
  close(options?: { keepFake?: boolean }): Promise<void>;
}

/**
 * The hermes module and the modules it needs (the bridge and its own), the FAKE Pi, and a FAKE Hermes on a loopback
 * port and a generated fake key in `<home>/hermes/pi-spore.key` (folder 0700, file 0600). Nothing here touches the real `~/.pi-spore/hermes`.
 */
export async function harness(
  options: {
    enabled?: false;
    settings?: Record<string, unknown>;
    /** A home to keep, so a second harness on it acts as a pi-spore restart. */
    home?: string;
    firstId?: number;
    /** The FAKE Hermes of an earlier harness, which stays up across the restart. */
    reuse?: Harness;
  } = {},
): Promise<Harness> {
  const key = options.reuse?.key ?? `fake-${randomBytes(24).toString("hex")}`;
  const fake = options.reuse?.fake ?? (await startFakeHermes({ key }));
  const timers = fakeTimer();
  const jobTimers = fakeTimer();
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 1_000,
  });
  const log: LogLine[] = [];
  const capture =
    (level: string): Logger["info"] =>
    (message, fields) => {
      log.push({ level, message, ...(fields ? { fields } : {}) });
    };
  let hermes: Hermes | undefined;
  let agentsApi: Agents | undefined;
  // A module that needs Hermes gets it the way later cards will: through HermesKey.
  const probe: ServerModule = {
    id: "hermes-probe",
    requires: ["hermes", "agents"],
    core: false,
    setup(host) {
      hermes = host.use(HermesKey);
      agentsApi = host.use(AgentsKey);
    },
  };
  const server = await createTestServer(
    [
      projectsModule,
      vcsFolderModule,
      workspacesModule,
      agents,
      actionsModule,
      attentionModule,
      kanbanModule,
      artifactsModule,
      pipelinesModule,
      runsModule,
      bridgeModule,
      createHermesModule({ timer: timers.timer }),
      probe,
    ],
    {
      log: { info: capture("info"), warn: capture("warn"), error: capture("error") },
      timer: jobTimers.timer,
      ...(options.home ? { home: options.home } : {}),
      ...(options.firstId ? { firstId: options.firstId } : {}),
    },
  );
  const folder = join(server.paths.root, "hermes");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const keyFile = join(folder, "pi-spore.key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const settings = (values: Record<string, unknown>) =>
    writeFileSync(
      join(server.paths.root, "settings.json"),
      JSON.stringify({ hermes: { url: fake.url, ...values } }),
    );
  // Off leaves hermes.enabled unset, so its default decides. The URL is always the fake's, so a request that should
  // not happen reaches the fake, where the test sees it, and never a real host.
  settings({ ...(options.enabled === false ? {} : { enabled: true }), ...options.settings });
  if (!hermes || !agentsApi) throw new Error("the hermes module did not provide HermesKey");
  return {
    server,
    fake,
    hermes,
    agents: agentsApi,
    key,
    keyFile,
    log,
    timers,
    jobTimers,
    settings,
    close: async ({ keepFake = false } = {}) => {
      await agents.manager().stopAll();
      server.close();
      if (!options.reuse && !keepFake) await fake.close();
    },
  };
}
