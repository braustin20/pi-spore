import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApiError } from "@pi-spore/module-api";
import type { RoleModel } from "@pi-spore/shared";
import { piSettingsPath, readPiSettings } from "./launch.js";

/** The roles pi-spore starts agents for, in the order the list shows them (ADR 0181). */
const SPORE_ROLES: readonly string[] = [
  "orchestrator",
  "planner",
  "coordinator",
  "worker",
  "reviewer",
  "adversarial-reviewer",
];
/** Roles with no model of their own run on the orchestrator's (ADR 0175, ADR 0181). */
const FALLBACK_ROLES: ReadonlySet<string> = new Set(["planner", "coordinator"]);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const notJson = (error: Error) => new ApiError(409, "pi_settings_not_json", error.message);
const shapeError = (path: string, message: string) =>
  new ApiError(409, "pi_settings_shape", `${path}: ${message}`);

/**
 * The name of an agent file from its YAML frontmatter `name` and `package`. No YAML parser: only these lines matter.
 * Without a closing `---` there is no frontmatter, and pi-subagents does not find the agent either.
 */
function frontmatterName(text: string): string | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const fields: Record<string, string> = {};
  let closed = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") {
      closed = true;
      break;
    }
    const match = /^(name|package):\s*(.*?)\s*$/.exec(line);
    if (match) fields[match[1] as string] = (match[2] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!closed || !fields.name) return undefined;
  return fields.package ? `${fields.package}.${fields.name}` : fields.name;
}

/** The names of the agent files in a folder. A missing folder has none. A file with no `name` is skipped. */
async function agentNames(dir: string, recursive: boolean): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry.endsWith(".chain.md")) continue;
    let text: string;
    try {
      text = await readFile(join(dir, entry), "utf8");
    } catch (error) {
      // A folder named like a file.
      if ((error as NodeJS.ErrnoException).code === "EISDIR") continue;
      throw error;
    }
    const name = frontmatterName(text);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Pi's settings file with its containers checked: the top level, `subagents`, and `subagents.agentOverrides` are
 * objects when they exist. A file that is missing is empty. Anything else that is not an object is an error, so a
 * write never replaces data it did not understand (ADR 0181).
 */
async function loadSettings(agentDir: string) {
  const path = piSettingsPath(agentDir);
  let raw: unknown;
  try {
    raw = await readPiSettings(agentDir);
  } catch (error) {
    throw notJson(error as Error);
  }
  const settings = raw === undefined ? {} : raw;
  if (!isObject(settings)) throw shapeError(path, "the top level is not an object");
  const subagents = settings.subagents as Json | undefined;
  if (subagents !== undefined && !isObject(subagents))
    throw shapeError(path, "`subagents` is not an object");
  const overrides = subagents?.agentOverrides as Json | undefined;
  if (overrides !== undefined && !isObject(overrides))
    throw shapeError(path, "`subagents.agentOverrides` is not an object");
  return { path, settings, overrides };
}

/**
 * Every name that can have a default model, with its model (ADR 0181): the pi-spore roles, pi-subagents' built-in
 * agents, the user's agents, and every name already in `agentOverrides`. Project agents and other packages' agents
 * are not listed.
 */
export async function listRoleModels(
  agentDir: string,
  builtinAgentsDir: string | undefined,
): Promise<RoleModel[]> {
  const { overrides = {} } = await loadSettings(agentDir);
  const others = new Set<string>(Object.keys(overrides));
  const found = [
    ...(builtinAgentsDir ? await agentNames(builtinAgentsDir, false) : []),
    ...(await agentNames(join(agentDir, "agents"), true)),
  ];
  for (const name of found) others.add(name);
  for (const role of SPORE_ROLES) others.delete(role);

  const names = [...SPORE_ROLES, ...[...others].sort()];
  return names.map((name) => {
    const override = overrides[name];
    const model = isObject(override) ? override.model : undefined;
    const entry: RoleModel = { name, kind: SPORE_ROLES.includes(name) ? "role" : "subagent" };
    if (typeof model === "string") entry.model = model;
    if (FALLBACK_ROLES.has(name)) entry.fallback = "orchestrator";
    return entry;
  });
}

/** Writes run one at a time, so two requests never read the same file and lose one change. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Sets (`model` a string) or removes (`model` undefined) `subagents.agentOverrides.<role>.model` and nothing else
 * (ADR 0181). Refuses a file that is not plain JSON or whose containers are not objects.
 */
export function writeRoleModel(
  agentDir: string,
  role: string,
  model: string | undefined,
): Promise<void> {
  const run = queue.then(async () => {
    const { path, settings, overrides } = await loadSettings(agentDir);
    if (model === undefined) {
      const override = overrides?.[role];
      if (!overrides || !isObject(override) || !Object.hasOwn(override, "model")) return;
      delete override.model;
      if (Object.keys(override).length === 0) delete overrides[role];
    } else {
      settings.subagents ??= {};
      const subagents = settings.subagents as Json;
      subagents.agentOverrides ??= {};
      const table = subagents.agentOverrides as Json;
      const existing = table[role];
      if (existing !== undefined && !isObject(existing))
        throw shapeError(path, `\`subagents.agentOverrides.${role}\` is not an object`);
      if (existing === undefined) table[role] = {};
      const override = table[role] as Json;
      override.model = model;
    }
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(`${path}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
      await rename(`${path}.tmp`, path);
    } catch (error) {
      await rm(`${path}.tmp`, { force: true });
      throw error;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
