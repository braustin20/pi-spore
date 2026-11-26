import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobTimer, Logger, ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { createHermesModule, type Hermes, HermesKey } from "../src/server.js";
import { type FakeHermes, startFakeHermes } from "../test-fixtures/fake-hermes.mjs";

export const TIMEOUT_MS = 10_000;

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
  key: string;
  keyFile: string;
  log: LogLine[];
  timers: ReturnType<typeof fakeTimer>;
  /** Writes `<home>/settings.json`. Settings are read fresh on every call. */
  settings(values: Record<string, unknown>): void;
  close(): Promise<void>;
}

/**
 * The hermes module alone on a temp home, with a FAKE Hermes on a loopback port and a generated fake key in
 * `<home>/hermes/pi-spore.key` (folder 0700, file 0600). Nothing here touches the real `~/.pi-spore/hermes`.
 */
export async function harness(
  options: { enabled?: false; settings?: Record<string, unknown> } = {},
): Promise<Harness> {
  const key = `fake-${randomBytes(24).toString("hex")}`;
  const fake = await startFakeHermes({ key });
  const timers = fakeTimer();
  const log: LogLine[] = [];
  const capture =
    (level: string): Logger["info"] =>
    (message, fields) => {
      log.push({ level, message, ...(fields ? { fields } : {}) });
    };
  let hermes: Hermes | undefined;
  // A module that needs Hermes gets it the way later cards will: through HermesKey.
  const probe: ServerModule = {
    id: "hermes-probe",
    requires: ["hermes"],
    core: false,
    setup(host) {
      hermes = host.use(HermesKey);
    },
  };
  const server = await createTestServer([createHermesModule({ timer: timers.timer }), probe], {
    log: { info: capture("info"), warn: capture("warn"), error: capture("error") },
  });
  const folder = join(server.paths.root, "hermes");
  mkdirSync(folder, { mode: 0o700 });
  chmodSync(folder, 0o700);
  const keyFile = join(folder, "pi-spore.key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const settings = (values: Record<string, unknown>) =>
    writeFileSync(
      join(server.paths.root, "settings.json"),
      JSON.stringify({ hermes: { url: fake.url, ...values } }),
    );
  // Off writes no settings file at all, so the default decides.
  if (options.enabled !== false) settings({ enabled: true, ...options.settings });
  if (!hermes) throw new Error("the hermes module did not provide HermesKey");
  return {
    server,
    fake,
    hermes,
    key,
    keyFile,
    log,
    timers,
    settings,
    close: async () => {
      server.close();
      await fake.close();
    },
  };
}
