import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLog } from "@pi-spore/server-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type Connector, createConnector, type HermesConfig } from "../src/client.js";
import { type FakeHermes, startFakeHermes } from "../test-fixtures/fake-hermes.mjs";
import { fakeTimer } from "./helpers.js";

// The connector alone, with a config the test swaps between two calls. Settings files cannot be changed at an exact
// point inside one call, so these races are driven here. Both Hermes servers are FAKES.

const TIMEOUT_MS = 1_000;
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup) await step();
  cleanup = [];
});

/** Lets every pending promise step run. No clock: one turn of the event loop. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup() {
  const key = `fake-${randomBytes(24).toString("hex")}`;
  const folder = mkdtempSync(join(tmpdir(), "pi-spore-hermes-key-"));
  chmodSync(folder, 0o700);
  const keyFile = join(folder, "pi-spore.key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const fakes: FakeHermes[] = [await startFakeHermes({ key }), await startFakeHermes({ key })];
  const [a, b] = fakes as [FakeHermes, FakeHermes];
  cleanup.push(async () => {
    for (const fake of fakes) await fake.close();
    rmSync(folder, { recursive: true, force: true });
  });
  const configOf = (fake: FakeHermes, profile = "pi-spore"): HermesConfig => ({
    enabled: true,
    url: fake.url,
    profile,
    keyFile,
  });
  const timers = fakeTimer();
  /** The configs the next reads answer, in order; the last one stays. */
  const reads: HermesConfig[] = [];
  const connector: Connector = createConnector({
    config: async () =>
      reads.length > 1 ? (reads.shift() as HermesConfig) : (reads[0] as HermesConfig),
    log: silentLog,
    now: () => 1,
    timer: timers.timer,
    timeoutMs: TIMEOUT_MS,
  });
  return { a, b, configOf, reads, timers, connector };
}

describe("Hermes connector config snapshots", () => {
  it("checks and sends to the same Hermes, even when the settings change during the call", async () => {
    const { a, b, configOf, reads, connector } = await setup();
    a.options.version = "0.24.0";
    // The call reads A. Any later read answers B, a ready Hermes.
    reads.push(configOf(a), configOf(b));
    await expect(
      connector.startRun({ input: "hi", session_id: "s" }, "k-snapshot"),
    ).rejects.toMatchObject({ code: "hermes_not_ready" });
    // A never passed its check, so it gets no keyed request; B gets nothing at all.
    expect(a.requests.map((request) => request.path)).toEqual(["/p/pi-spore/health"]);
    expect(b.requests).toEqual([]);
  });

  it("joins the check of the current config, even when an older check ends first", async () => {
    const { a, configOf, reads, timers, connector } = await setup();
    a.options.holdAll = true;
    reads.push(configOf(a));
    const first = connector.status();
    await expect.poll(() => a.requests.length).toBe(1);
    reads[0] = configOf(a, "other");
    const second = connector.status();
    await expect.poll(() => a.requests.length).toBe(2);
    // The older check times out first.
    await timers.fireOne(TIMEOUT_MS);
    expect(await first).toMatchObject({ state: "unreachable" });
    const third = connector.status();
    await settle();
    // Joining the second check arms no new request.
    expect(timers.delays()).toEqual([TIMEOUT_MS]);
    await timers.fireOne(TIMEOUT_MS);
    expect(await third).toBe(await second);
    expect(a.requests.map((request) => request.path)).toEqual([
      "/p/pi-spore/health",
      "/p/other/health",
    ]);
  });
});
