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
        router: { threshold: 0.8, pressure: { weekly: 0.9 }, cloud: "anthropic/claude-sonnet-5-5" },
        tiers: { "llama-cpp/qwen3.8-27b-m": "local" },
      }),
    );
    const settings = await loadSettings(home);
    expect(settings.threshold).toBe(0.8);
    expect(settings.pressure).toEqual({ weekly: 0.9, fiveHour: 1 });
    expect(settings.cloud).toBe("anthropic/claude-sonnet-5-5");
    expect(tierOf(settings, "llama-cpp/qwen3.8-27b-m")).toBe("local");
    expect(tierOf(settings, "claude-bridge/claude-opus-5-5")).toBe("heavy");
  });

  it("rejects a wrong value and an unknown router key, naming the file", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ router: { threshold: 2 } }));
    await expect(loadSettings(home)).rejects.toThrow(/settings\.json: \/router\/threshold/);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ router: { thresold: 0.5 } }));
    await expect(loadSettings(home)).rejects.toThrow(/settings\.json/);
    writeFileSync(join(home, "settings.json"), "{ nope");
    await expect(loadSettings(home)).rejects.toThrow("settings.json is not valid JSON");
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
