import { describe, expect, it } from "vitest";
import { createInterfaceBroker } from "./interfaces.js";
import { defineInterface, type ModuleManifest } from "./manifest.js";
import { ModuleRegistryError, resolveModules } from "./registry.js";

const mod = (id: string, requires: string[] = [], core = false): ModuleManifest => ({
  id,
  requires,
  core,
});
const ids = (modules: readonly ModuleManifest[]) => modules.map((module) => module.id);

describe("resolveModules", () => {
  it("returns an empty list for an empty registry", () => {
    expect(resolveModules([])).toEqual([]);
  });

  it("orders dependencies before dependents and keeps registry order otherwise", () => {
    const registry = [
      mod("chat", ["agents"]),
      mod("kanban"),
      mod("agents", ["projects"]),
      mod("projects"),
    ];
    expect(ids(resolveModules(registry))).toEqual(["projects", "agents", "chat", "kanban"]);
  });

  it("rejects duplicate ids", () => {
    expect(() => resolveModules([mod("chat"), mod("chat")])).toThrow(
      new ModuleRegistryError('Module id "chat" is registered more than once'),
    );
  });

  it("rejects a required module that is not registered", () => {
    expect(() => resolveModules([mod("chat", ["agents"])])).toThrow(
      'Module "chat" requires "agents", which is not registered',
    );
  });

  it("rejects a required module that is disabled", () => {
    expect(() => resolveModules([mod("agents"), mod("chat", ["agents"])], ["agents"])).toThrow(
      'Module "chat" requires "agents", which is disabled',
    );
  });

  it("allows disabling a module nothing enabled requires", () => {
    const registry = [mod("agents"), mod("chat", ["agents"]), mod("kanban")];
    expect(ids(resolveModules(registry, ["kanban"]))).toEqual(["agents", "chat"]);
  });

  it("allows disabling a module together with the modules that require it", () => {
    const registry = [mod("agents"), mod("chat", ["agents"])];
    expect(ids(resolveModules(registry, ["agents", "chat"]))).toEqual([]);
  });

  it("refuses to disable a core module", () => {
    expect(() => resolveModules([mod("projects", [], true)], ["projects"])).toThrow(
      'Module "projects" is core and cannot be disabled',
    );
  });

  it("rejects an unknown id in the disabled list", () => {
    expect(() => resolveModules([mod("chat")], ["chta"])).toThrow(
      'Disabled module "chta" is not registered',
    );
  });

  it("rejects a dependency cycle and names it", () => {
    const registry = [mod("a", ["b"]), mod("b", ["c"]), mod("c", ["a"])];
    expect(() => resolveModules(registry)).toThrow("Module dependency cycle: a -> b -> c -> a");
  });

  it("rejects a module that requires itself", () => {
    expect(() => resolveModules([mod("a", ["a"])])).toThrow("Module dependency cycle: a -> a");
  });
});

describe("createInterfaceBroker", () => {
  const Count = defineInterface<{ count(): number }>("agents", "count");

  it("lets a module use an interface of a module it requires", () => {
    const broker = createInterfaceBroker();
    broker.forModule(mod("agents")).provide(Count, { count: () => 3 });
    expect(
      broker
        .forModule(mod("chat", ["agents"]))
        .use(Count)
        .count(),
    ).toBe(3);
  });

  it("rejects use of an interface from a module that is not required", () => {
    const broker = createInterfaceBroker();
    broker.forModule(mod("agents")).provide(Count, { count: () => 3 });
    expect(() => broker.forModule(mod("kanban")).use(Count)).toThrow(
      'Module "kanban" uses "agents/count" but does not require "agents"',
    );
  });

  it("rejects providing an interface owned by another module", () => {
    const broker = createInterfaceBroker();
    expect(() => broker.forModule(mod("chat")).provide(Count, { count: () => 1 })).toThrow(
      'Module "chat" cannot provide "agents/count", which belongs to "agents"',
    );
  });

  it("rejects providing the same interface twice", () => {
    const broker = createInterfaceBroker();
    const agents = broker.forModule(mod("agents"));
    agents.provide(Count, { count: () => 1 });
    expect(() => agents.provide(Count, { count: () => 2 })).toThrow(
      'Interface "agents/count" is provided more than once',
    );
  });

  it("rejects use of an interface that was never provided", () => {
    const broker = createInterfaceBroker();
    expect(() => broker.forModule(mod("chat", ["agents"])).use(Count)).toThrow(
      'Interface "agents/count" was not provided by "agents" during its setup',
    );
  });
});
