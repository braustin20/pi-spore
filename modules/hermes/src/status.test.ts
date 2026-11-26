import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import type { HermesStatus } from "@pi-spore/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "./test-helpers.js";

// Every test runs against a FAKE Hermes (test-fixtures/fake-hermes.mjs). Passing here is not live proof.

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const status = async (setup: Harness): Promise<HermesStatus> => {
  const response = await setup.server.request("GET", "/api/hermes/status");
  expect(response.status).toBe(200);
  return (await response.json()) as HermesStatus;
};

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("Hermes connector status", () => {
  it("is off by default and sends Hermes nothing, not even from the poll or a client call", async () => {
    h = await harness({ enabled: false });
    expect(await status(h)).toEqual({ state: "disabled" });
    await h.timers.fire(0);
    await h.timers.fire(60_000);
    await expect(h.hermes.startRun({ input: "hi", session_id: "s" }, "k1")).rejects.toMatchObject({
      code: "hermes_not_ready",
    });
    await expect(h.hermes.listSessions()).rejects.toMatchObject({ code: "hermes_not_ready" });
    expect(h.fake.requests).toEqual([]);
  });

  it("is ready against the fake, after health, capabilities, and models", async () => {
    h = await harness();
    expect(await status(h)).toMatchObject({
      state: "ready",
      version: "0.23.3",
      url: h.fake.url,
      profile: "pi-spore",
    });
    expect(h.fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /p/pi-spore/health",
      "GET /p/pi-spore/v1/capabilities",
      "GET /p/pi-spore/v1/models",
    ]);
    // The health check needs no key, so none is sent there.
    expect(h.fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(h.fake.requests[1]?.headers.authorization).toBe(`Bearer ${h.key}`);
  });

  it("is incompatible on a missing capability flag, and names it", async () => {
    h = await harness();
    h.fake.options.missingFlag = "run_unknown_resolution";
    const now = await status(h);
    expect(now.state).toBe("incompatible");
    expect("detail" in now && now.detail).toContain("run_unknown_resolution");
  });

  it("is incompatible on a flag that is false, and names it", async () => {
    h = await harness();
    h.fake.options.falseFlag = "run_stop";
    const now = await status(h);
    expect(now).toMatchObject({ state: "incompatible" });
    expect("detail" in now && now.detail).toContain("run_stop");
  });

  it("is incompatible on an untested minor version, and names both versions", async () => {
    h = await harness();
    h.fake.options.version = "0.24.0";
    const now = await status(h);
    expect(now.state).toBe("incompatible");
    expect("detail" in now && now.detail).toContain("0.24.0");
    expect("detail" in now && now.detail).toContain("0.23.x");
    // It stops at the version: no keyed request goes to an untested Hermes.
    expect(h.fake.requests.map((request) => request.path)).toEqual(["/p/pi-spore/health"]);
  });

  it("is incompatible when /v1/models does not list the profile's model", async () => {
    h = await harness();
    h.fake.options.models = ["homelab-maintainer"];
    const now = await status(h);
    expect(now.state).toBe("incompatible");
    expect("detail" in now && now.detail).toContain("pi-spore");
  });

  it("is unauthorized on a 401, naming the key file and not the key", async () => {
    h = await harness();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(h.keyFile, "fake-wrong-key", { mode: 0o600 });
    const now = await status(h);
    expect(now.state).toBe("unauthorized");
    expect("detail" in now && now.detail).toContain(h.keyFile);
    expect(JSON.stringify(now)).not.toContain("fake-wrong-key");
  });

  it("is unreachable on a closed port", async () => {
    h = await harness();
    h.settings({ enabled: true, url: `http://127.0.0.1:${await closedPort()}` });
    expect(await status(h)).toMatchObject({ state: "unreachable" });
  });

  it("is unreachable on a 5xx answer", async () => {
    h = await harness();
    h.fake.options.serverError = true;
    expect(await status(h)).toMatchObject({ state: "unreachable" });
  });

  it("is unreachable when Hermes does not answer in time", async () => {
    h = await harness();
    h.fake.options.holdAll = true;
    const pending = status(h);
    await expect.poll(() => h?.fake.requests.length).toBe(1);
    await h.timers.fire(10_000);
    const now = await pending;
    expect(now.state).toBe("unreachable");
    expect("detail" in now && now.detail).toContain("10000 ms");
  });

  it("polls with backoff while Hermes fails, and slowly once it is ready", async () => {
    h = await harness();
    h.fake.options.serverError = true;
    await h.timers.fire(0);
    expect(h.timers.delays()).toEqual([5_000]);
    await h.timers.fire(5_000);
    expect(h.timers.delays()).toEqual([10_000]);
    await h.timers.fire(10_000);
    expect(h.timers.delays()).toEqual([20_000]);
    h.fake.options.serverError = false;
    await h.timers.fire(20_000);
    expect(h.timers.delays()).toEqual([60_000]);
    expect(await status(h)).toMatchObject({ state: "ready" });
  });

  it("refuses an unsafe Hermes URL in settings", async () => {
    h = await harness();
    h.settings({ enabled: true, url: "http://user:pw@hermes-docker:8642" });
    const response = await h.server.request("GET", "/api/hermes/status");
    expect(response.status).toBe(422);
    h.settings({ enabled: true, url: "http://hermes-docker:8642/p/pi-spore" });
    expect((await h.server.request("GET", "/api/hermes/status")).status).toBe(422);
    // URL parsing reads a backslash as a path separator.
    h.settings({ enabled: true, url: `${h.fake.url}\\p\\other` });
    expect((await h.server.request("GET", "/api/hermes/status")).status).toBe(422);
    expect(h.fake.requests).toEqual([]);
  });

  it("checks again on Reload (POST /api/hermes/refresh), not only at the next poll", async () => {
    h = await harness();
    chmodSync(h.keyFile, 0o644);
    expect(await status(h)).toMatchObject({ state: "unauthorized" });
    chmodSync(h.keyFile, 0o600);
    // The GET answers the cached status; the Reload checks now.
    expect(await status(h)).toMatchObject({ state: "unauthorized" });
    const reload = await h.server.request("POST", "/api/hermes/refresh");
    expect(reload.status).toBe(200);
    expect(await reload.json()).toMatchObject({ state: "ready" });
    expect(await status(h)).toMatchObject({ state: "ready" });
  });

  it("lets a client call check again when the cached status is a failure", async () => {
    h = await harness();
    h.fake.options.serverError = true;
    expect(await status(h)).toMatchObject({ state: "unreachable" });
    h.fake.options.serverError = false;
    const admitted = await h.hermes.startRun({ input: "hi", session_id: "s" }, "k-back");
    expect(admitted.run_id).toBe("run_fake1");
  });

  it("is unauthorized on a 403", async () => {
    h = await harness();
    h.fake.options.answers["/v1/capabilities"] = { status: 403, raw: "{}" };
    const now = await status(h);
    expect(now.state).toBe("unauthorized");
    expect("detail" in now && now.detail).toContain("403");
  });

  it("is incompatible when health is not JSON or has no version", async () => {
    h = await harness();
    h.fake.options.answers["/health"] = { status: 200, raw: "<html>" };
    expect(await status(h)).toMatchObject({
      state: "incompatible",
      detail: expect.stringContaining("not JSON"),
    });
    h.fake.options.answers["/health"] = { status: 200, raw: '{"status":"ok"}' };
    const reload = await h.server.request("POST", "/api/hermes/refresh");
    expect(await reload.json()).toMatchObject({
      state: "incompatible",
      detail: expect.stringContaining("version"),
    });
  });

  it("takes a tested version without a patch part", async () => {
    h = await harness();
    h.fake.options.version = "0.23";
    expect(await status(h)).toMatchObject({ state: "ready", version: "0.23" });
  });
});
