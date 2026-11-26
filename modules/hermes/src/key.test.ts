import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HermesStatus } from "@pi-spore/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "./test-helpers.js";

// The key is a generated fake value in a temp home. The real ~/.pi-spore/hermes is never read.

let h: Harness | undefined;
afterEach(async () => {
  if (h) chmodSync(dirname(h.keyFile), 0o700);
  await h?.close();
  h = undefined;
});

const status = async (setup: Harness) =>
  (await (await setup.server.request("GET", "/api/hermes/status")).json()) as HermesStatus;

/** Refused before any keyed request; the detail names the path, never the key. */
async function expectRefused(setup: Harness, words: string) {
  const now = await status(setup);
  expect(now.state).toBe("unauthorized");
  expect("detail" in now && now.detail).toContain(setup.keyFile);
  expect("detail" in now && now.detail).toContain(words);
  expect(JSON.stringify(now)).not.toContain(setup.key);
  expect(setup.fake.requests.filter((request) => request.headers.authorization)).toEqual([]);
}

describe("Hermes key file", () => {
  it("reads the default path <home>/hermes/pi-spore.key", async () => {
    h = await harness();
    expect(await status(h)).toMatchObject({ state: "ready" });
  });

  it("refuses a key file with mode 0644", async () => {
    h = await harness();
    chmodSync(h.keyFile, 0o644);
    await expectRefused(h, "0644");
  });

  it("refuses a key folder with mode 0755", async () => {
    h = await harness();
    chmodSync(dirname(h.keyFile), 0o755);
    await expectRefused(h, "0755");
  });

  it("refuses a missing key file", async () => {
    h = await harness();
    rmSync(h.keyFile);
    await expectRefused(h, "does not exist");
  });

  it("refuses an empty key file", async () => {
    h = await harness();
    writeFileSync(h.keyFile, "\n");
    await expectRefused(h, "empty");
  });

  it("follows hermes.keyFile and hermes.profile", async () => {
    h = await harness();
    h.settings({ enabled: true, keyFile: `${dirname(h.keyFile)}/other.key` });
    const now = await status(h);
    expect(now.state).toBe("unauthorized");
    expect("detail" in now && now.detail).toContain("other.key");
  });

  it("names the profile's own key file by default", async () => {
    h = await harness();
    h.settings({ enabled: true, profile: "other" });
    const now = await status(h);
    expect(now.state).toBe("unauthorized");
    expect("detail" in now && now.detail).toContain(`${dirname(h.keyFile)}/other.key`);
  });

  it("reads a key file under ~/ from the user's home", async () => {
    h = await harness();
    // The user's home is the temp home here, so nothing under the real ~ is read.
    vi.stubEnv("HOME", h.server.paths.root);
    try {
      h.settings({ enabled: true, keyFile: "~/hermes/pi-spore.key" });
      expect(await status(h)).toMatchObject({ state: "ready" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a relative key file path", async () => {
    h = await harness();
    h.settings({ enabled: true, keyFile: "hermes/pi-spore.key" });
    const now = await status(h);
    expect(now.state).toBe("unauthorized");
    expect("detail" in now && now.detail).toContain("not an absolute path");
  });

  it("refuses a key with bytes a header cannot carry, without quoting it", async () => {
    h = await harness();
    writeFileSync(h.keyFile, `${h.key} second-line`);
    await expectRefused(h, "characters a key cannot have");
  });
});
