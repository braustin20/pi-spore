import { describe, expect, it } from "vitest";
import { type CliDeps, run } from "./cli.js";

function fakeDeps(fetchImpl: (url: URL) => Promise<Response>, env: CliDeps["env"] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const requested: string[] = [];
  const deps: CliDeps = {
    fetch: ((input: URL) => {
      requested.push(input.toString());
      return fetchImpl(input);
    }) as typeof fetch,
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, out, err, requested };
}

const healthy = () =>
  Promise.resolve(
    Response.json({ status: "ok", version: "0.1.0", uptimeMs: 65_400, modules: ["projects"] }),
  );

describe("pi-spore health", () => {
  it("prints a one-line summary from the default address", async () => {
    const { deps, out, err, requested } = fakeDeps(healthy);

    expect(await run(["health"], deps)).toBe(0);
    expect(requested).toEqual(["http://127.0.0.1:7420/api/health"]);
    expect(out).toEqual(["ok  version 0.1.0  up 65s  modules: projects"]);
    expect(err).toEqual([]);
  });

  it("prints the raw response with --json", async () => {
    const { deps, out } = fakeDeps(healthy);

    expect(await run(["health", "--json"], deps)).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toEqual({
      status: "ok",
      version: "0.1.0",
      uptimeMs: 65_400,
      modules: ["projects"],
    });
  });

  it("uses PI_SPORE_URL when set", async () => {
    const { deps, requested } = fakeDeps(healthy, { PI_SPORE_URL: "http://127.0.0.1:9999" });

    await run(["health"], deps);
    expect(requested).toEqual(["http://127.0.0.1:9999/api/health"]);
  });

  it("fails with exit 1 when the server is not reachable", async () => {
    const { deps, err } = fakeDeps(() => Promise.reject(new TypeError("fetch failed")));

    expect(await run(["health"], deps)).toBe(1);
    expect(err[0]).toContain("pi-spore server is not reachable at http://127.0.0.1:7420");
  });

  it("fails with exit 1 on an error status", async () => {
    const { deps, err } = fakeDeps(() =>
      Promise.resolve(new Response("", { status: 500, statusText: "Internal Server Error" })),
    );

    expect(await run(["health"], deps)).toBe(1);
    expect(err[0]).toContain("answered 500 Internal Server Error");
  });

  it("fails with exit 1 on a response that does not match the schema", async () => {
    const { deps, err } = fakeDeps(() => Promise.resolve(Response.json({ status: "ok" })));

    expect(await run(["health"], deps)).toBe(1);
    expect(err[0]).toContain("sent a bad health response");
  });
});

describe("pi-spore usage", () => {
  it("prints usage and exits 2 with no command", async () => {
    const { deps, out } = fakeDeps(healthy);

    expect(await run([], deps)).toBe(2);
    expect(out[0]).toContain("Usage: pi-spore");
  });

  it("rejects an unknown command with exit 2", async () => {
    const { deps, err } = fakeDeps(healthy);

    expect(await run(["frobnicate"], deps)).toBe(2);
    expect(err[0]).toContain("Unknown command: frobnicate");
  });
});
