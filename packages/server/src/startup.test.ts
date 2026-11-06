import { defineInterface, type Logger, type ServerModule } from "@pi-spore/module-api";
import { describe, expect, it } from "vitest";
import { setupModules } from "./startup.js";

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("setupModules", () => {
  it("sets modules up in dependency order and passes interfaces between them", async () => {
    const Greeting = defineInterface<() => string>("base", "greeting");
    const calls: string[] = [];
    const base: ServerModule = {
      id: "base",
      requires: [],
      core: true,
      setup(host) {
        calls.push("base");
        host.provide(Greeting, () => "hello");
      },
    };
    const feature: ServerModule = {
      id: "feature",
      requires: ["base"],
      core: false,
      setup(host) {
        calls.push(`feature:${host.use(Greeting)()}`);
      },
    };

    const ordered = await setupModules([feature, base], [], silent);

    expect(ordered.map((module) => module.id)).toEqual(["base", "feature"]);
    expect(calls).toEqual(["base", "feature:hello"]);
  });

  it("runs no setup when the registry is invalid", async () => {
    const calls: string[] = [];
    const broken: ServerModule = {
      id: "broken",
      requires: ["missing"],
      core: false,
      setup: () => {
        calls.push("broken");
      },
    };

    await expect(setupModules([broken], [], silent)).rejects.toThrow(
      'Module "broken" requires "missing", which is not registered',
    );
    expect(calls).toEqual([]);
  });
});
