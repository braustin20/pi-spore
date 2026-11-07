import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentEnv,
  modelArgs,
  readRoleDefaults,
  resolveResourceArgs,
  SPORE_EXTENSIONS,
} from "./launch.js";

let root: string;
let agentDir: string;
let project: string;

/** A local Pi package with one extension and one skill. */
function makePackage(name: string): string {
  const dir = join(root, "packages", name);
  mkdirSync(join(dir, "skills", `${name}-skill`), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, pi: { extensions: ["./ext.ts"], skills: ["./skills"] } }),
  );
  writeFileSync(join(dir, "ext.ts"), "export default function () {}\n");
  writeFileSync(
    join(dir, "skills", `${name}-skill`, "SKILL.md"),
    `---\nname: ${name}-skill\ndescription: A test skill.\n---\nBody\n`,
  );
  return dir;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-launch-")));
  agentDir = join(root, "agent");
  project = join(root, "project");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(agentDir, "extensions", "mine.ts"), "export default function () {}\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveResourceArgs", () => {
  it("lists every enabled resource explicitly, minus excluded packages and disabled built-ins", async () => {
    const tools = makePackage("tools");
    const lens = makePackage("lens");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [tools, lens], extensions: ["-builtin:mcp"] }),
    );

    const args = await resolveResourceArgs(project, agentDir, [lens]);

    const values = (flag: string) => args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));
    expect(args[0]).toBe("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-prompt-templates");
    expect(values("-e")).toEqual(
      expect.arrayContaining([
        join(agentDir, "extensions", "mine.ts"),
        join(tools, "ext.ts"),
        "builtin:llama.cpp",
      ]),
    );
    expect(values("-e")).not.toContain("builtin:mcp");
    expect(values("-e").some((path) => path.startsWith(lens))).toBe(false);
    expect(values("--skill").some((path) => path.startsWith(join(tools, "skills")))).toBe(true);
    expect(values("--skill").some((path) => path.startsWith(lens))).toBe(false);
  });
});

describe("pi-spore's own extensions", () => {
  it("come after the user's, once, and point at the router package", async () => {
    const extra = makePackage("extra");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    const values = (args: string[]) =>
      args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));

    const args = values(await resolveResourceArgs(project, agentDir, [], [extra]));
    expect(args.at(-1)).toBe(extra);
    expect(args).toContain(join(agentDir, "extensions", "mine.ts"));

    // The user's setup already loads it: no second copy.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [extra] }));
    const deduped = values(await resolveResourceArgs(project, agentDir, [], [extra]));
    expect(deduped.filter((path) => path.startsWith(extra))).toEqual([join(extra, "ext.ts")]);

    const [router] = SPORE_EXTENSIONS;
    const manifest = JSON.parse(readFileSync(join(router as string, "package.json"), "utf8"));
    expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
  });
});

describe("readRoleDefaults", () => {
  it("reads provider, model, and thinking of a role from the pi-subagents settings", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        subagents: {
          agentOverrides: {
            worker: { model: "claude-bridge/claude-sonnet-5-5", thinking: "high" },
          },
        },
      }),
    );
    const defaults = await readRoleDefaults(agentDir, "worker");
    expect(defaults).toEqual({
      provider: "claude-bridge",
      modelId: "claude-sonnet-5-5",
      thinking: "high",
    });
    expect(modelArgs(defaults)).toEqual([
      "--provider",
      "claude-bridge",
      "--model",
      "claude-sonnet-5-5",
      "--thinking",
      "high",
    ]);
  });

  it("returns nothing when there is no settings file or no override", async () => {
    expect(await readRoleDefaults(agentDir, "worker")).toEqual({});
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents: {} }));
    expect(await readRoleDefaults(agentDir, "worker")).toEqual({});
  });

  it("names the file when it is not JSON", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{ nope");
    await expect(readRoleDefaults(agentDir, "worker")).rejects.toThrow(
      "settings.json is not valid JSON",
    );
  });
});

describe("agentEnv", () => {
  it("drops the host terminal's Orca and herdr variables and adds the agent's own", () => {
    expect(
      agentEnv(
        { PATH: "/bin", ORCA_PANE_KEY: "p", HERDR_ENV: "h", HOME: "/h", EMPTY: undefined },
        { PI_SPORE_AGENT_ID: "a" },
      ),
    ).toEqual({ PATH: "/bin", HOME: "/h", PI_SPORE_AGENT_ID: "a" });
  });
});
