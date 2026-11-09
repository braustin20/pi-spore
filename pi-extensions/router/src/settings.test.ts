import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, splitModel, tierOf } from "./settings.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-spore-settings-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("loadSettings", () => {
  it("uses the built-in defaults without a settings file", async () => {
    expect(await loadSettings(home)).toEqual(DEFAULT_SETTINGS);
  });

  it("overlays the router and tiers sections and ignores the server's keys", async () => {
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        disabledModules: ["unity"],
        router: { threshold: 0.8, maxQueued: 3, pressure: { weekly: 0.9 } },
        tiers: { "llama-cpp/qwen3.8-27b-m": "local" },
      }),
    );
    const settings = await loadSettings(home);
    expect(settings.threshold).toBe(0.8);
    expect(settings.pressure).toEqual({ weekly: 0.9, fiveHour: 1 });
    expect(settings.maxQueued).toBe(3);
    expect(tierOf(settings, "llama-cpp/qwen3.8-27b-m")).toBe("local");
    expect(tierOf(settings, "claude-bridge/claude-opus-5-5")).toBe("heavy");
  });

  it("rejects a wrong value and an unknown router key, naming the file", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ router: { threshold: 2 } }));
    await expect(loadSettings(home)).rejects.toThrow(/settings\.json: \/router\/threshold/);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ router: { explore: 1.5 } }));
    await expect(loadSettings(home)).rejects.toThrow(/settings\.json: \/router\/explore/);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ router: { thresold: 0.5 } }));
    await expect(loadSettings(home)).rejects.toThrow(/settings\.json/);
    writeFileSync(join(home, "settings.json"), "{ nope");
    await expect(loadSettings(home)).rejects.toThrow("settings.json is not valid JSON");
  });
});

describe("ladders (ADR 0141)", () => {
  const entry = (model: string) => ({ model, thinking: "high" });
  const ladder = (...models: string[]) => ({ plan: "mine", rungs: models.map(entry) });
  const load = async (router: unknown, tiers?: unknown) => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ router, tiers }));
    return loadSettings(home);
  };

  it("has no Terra anywhere in the defaults", () => {
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toContain("terra");
  });

  it("has the router keys of ADR 0141 and the Strata thinking level", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ heavyThreshold: 0.7, large: 100_000, maxQueued: 1 });
    expect(DEFAULT_SETTINGS.localTargets[0]?.thinking).toBe("high");
    expect(DEFAULT_SETTINGS.ladders.map((ladder) => ladder.plan)).toEqual([
      "claude",
      "codex",
      "openrouter",
    ]);
  });

  it("ranks Fable as tier top", () => {
    expect(tierOf(DEFAULT_SETTINGS, "claude-bridge/claude-fable-5-1")).toBe("top");
    expect(tierOf(DEFAULT_SETTINGS, "anthropic/claude-fable-5-1")).toBe("top");
  });

  it("replaces the whole default list with a custom one", async () => {
    const custom = ladder("a/one", "a/two", "a/three");
    expect((await load({ ladders: [custom] })).ladders).toEqual([custom]);
  });

  it("refuses a ladder without exactly three rungs, or with no ladders", async () => {
    await expect(load({ ladders: [ladder("a/one", "a/two")] })).rejects.toThrow(/router\/ladders/);
    await expect(load({ ladders: [] })).rejects.toThrow(/router\/ladders/);
  });

  it("refuses a top model, naming the setting and the model", async () => {
    const top = ladder("a/one", "a/two", "claude-bridge/claude-fable-5-1");
    await expect(load({ ladders: [ladder("a/x", "a/y", "a/z"), top] })).rejects.toThrow(
      `router.ladders[1].rungs[2].model claude-bridge/claude-fable-5-1 is tier top; the router never routes to a top model (ADR 0141) in ${join(home, "settings.json")}`,
    );
    await expect(
      load({ ladders: [ladder("a/one", "a/two", "a/three")] }, { "a/two": "top" }),
    ).rejects.toThrow("router.ladders[0].rungs[1].model a/two is tier top");
  });

  it("refuses spore/auto in a ladder and in a local target", async () => {
    await expect(load({ ladders: [ladder("a/one", "spore/auto", "a/three")] })).rejects.toThrow(
      `router.ladders[0].rungs[1].model is spore/auto; the router cannot route to itself in ${join(home, "settings.json")}`,
    );
    const target = {
      model: "spore/auto",
      thinking: "high",
      contextWindow: 1000,
      budget: 0.5,
      concurrency: 1,
    };
    await expect(load({ localTargets: [target] })).rejects.toThrow(
      "router.localTargets[0].model is spore/auto",
    );
  });

  it("refuses a bad thinking level and a local target without one", async () => {
    const bad = {
      plan: "mine",
      rungs: ["a/one", "a/two", "a/three"].map((model) => ({ model, thinking: "ultra" })),
    };
    await expect(load({ ladders: [bad] })).rejects.toThrow(
      /router\/ladders\/0\/rungs\/0\/thinking/,
    );
    const target = { model: "a/local", contextWindow: 1000, budget: 0.5, concurrency: 1 };
    await expect(load({ localTargets: [target] })).rejects.toThrow(/router\/localTargets\/0/);
  });

  it.each(["cloud", "spill"])("refuses router.%s and points to router.ladders", async (key) => {
    await expect(load({ [key]: key === "cloud" ? "a/one" : ["a/one"] })).rejects.toThrow(
      `"router.${key}" was replaced by "router.ladders" (ADR 0141); remove it from ${join(home, "settings.json")}`,
    );
  });
});

describe("splitModel", () => {
  it("splits at the first slash, so ids may hold slashes", () => {
    expect(splitModel("openrouter/~typesafe/jev-latest")).toEqual({
      provider: "openrouter",
      id: "~typesafe/jev-latest",
    });
    expect(() => splitModel("sonnet")).toThrow("sonnet is not provider/id");
  });
});
