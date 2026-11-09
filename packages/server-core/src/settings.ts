import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApiError,
  type RawConfigFile,
  type RawConfigFiles,
  type ResolvedSettings,
  type SettingDef,
  type Settings,
} from "@pi-spore/module-api";
import { parse, type SettingEntry, type SettingSource, ValidationError } from "@pi-spore/shared";
import { parse as parseToml } from "smol-toml";
import type { Static, TSchema } from "typebox";

// R17.3: the project file may be committed and never chooses models.
const MODEL_KEYS = new Set(["model", "models", "provider", "thinking"]);

function findModelKey(value: unknown, path: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (MODEL_KEYS.has(key)) return here;
    const found = findModelKey(child, here);
    if (found) return found;
  }
  return undefined;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Parses TOML. The committed project file never holds model keys (R17.3); the local override may. */
async function readConfig(
  path: string,
  options: { models: "never" | "allowed" },
): Promise<RawConfigFile | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  let data: Record<string, unknown>;
  // smol-toml returns a plain table for any valid document.
  try {
    data = parseToml(text);
  } catch (error) {
    throw new ApiError(
      422,
      "bad_project_config",
      `${path} is not valid TOML: ${(error as Error).message}`,
    );
  }
  const modelKey = options.models === "never" ? findModelKey(data, "") : undefined;
  if (modelKey) {
    throw new ApiError(
      422,
      "bad_project_config",
      `${path} sets "${modelKey}". The project file never chooses models; use Pi settings, global settings, or a local override.`,
    );
  }
  return { path, data };
}

async function readGlobal(path: string): Promise<RawConfigFile | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(422, "bad_settings", `${path} is not valid JSON`);
  }
  if (!isTable(data)) throw new ApiError(422, "bad_settings", `${path} must hold a JSON object`);
  return { path, data };
}

function checkSection<const S extends TSchema>(
  schema: S,
  value: unknown,
  what: string,
  code = "bad_project_config",
): Static<S> {
  try {
    return parse(schema, value, what);
  } catch (error) {
    if (error instanceof ValidationError) throw new ApiError(422, code, error.message);
    throw error;
  }
}

type Layer = { file: RawConfigFile; source: SettingSource; code: string };

/**
 * The settings of one install (R17, architecture 13). `home` is the pi-spore home folder. Modules declare keys in
 * their setup, so until `finishDeclaring` runs, a key nobody declared yet is not an error. `finishDeclaring` then
 * checks the files once against every declaration and fails startup on a bad one.
 */
export function createSettings(home: string): Settings & { finishDeclaring(): Promise<void> } {
  let declaring = true;
  const defs = new Map<string, SettingDef>();
  const reserved = { global: new Set<string>(), project: new Set<string>() };
  const globalPath = join(home, "settings.json");

  const configFiles = async (projectPath: string): Promise<RawConfigFiles> => {
    const dir = join(projectPath, ".pi-spore");
    const project = await readConfig(join(dir, "config.toml"), { models: "never" });
    const local = await readConfig(join(dir, "config.local.toml"), { models: "allowed" });
    return { ...(project ? { project } : {}), ...(local ? { local } : {}) };
  };

  /** Checks each key a file sets against the declarations and returns its values. */
  const read = ({ file, source, code }: Layer): Map<string, unknown> => {
    const found = new Map<string, unknown>();
    const fail = (message: string): never => {
      throw new ApiError(422, code, `${file.path}: ${message}`);
    };
    const walk = (table: Record<string, unknown>, prefix: string): void => {
      for (const [name, child] of Object.entries(table)) {
        // A quoted "a.b" would match the setting path a.b and skip the model-key scan of the nested form.
        if (name.includes(".")) fail(`key "${name}" has a dot; write it as a nested table`);
        const key = prefix ? `${prefix}.${name}` : name;
        if (!prefix && reserved[source === "global" ? "global" : "project"].has(name)) continue;
        const def = defs.get(key);
        if (def) {
          if (def.scope === "global" && source !== "global")
            fail(`"${key}" is a global setting; set it in ${globalPath}`);
          found.set(key, checkSection(def.schema, child, `${file.path}: ${key}`, code));
        } else if (![...defs.keys()].some((known) => known.startsWith(`${key}.`))) {
          if (!declaring) fail(`unknown key "${key}"`);
        } else if (isTable(child)) {
          walk(child, key);
        } else {
          fail(`"${key}" must be a table`);
        }
      }
    };
    walk(file.data, "");
    return found;
  };

  const settings: Settings = {
    declare(def) {
      if (!declaring) throw new Error(`Setting "${def.key}" is declared after startup`);
      if (defs.has(def.key)) throw new Error(`Setting "${def.key}" is declared twice`);
      defs.set(def.key, def);
      return def;
    },
    reserve(file, section) {
      reserved[file].add(section);
    },
    configFiles,
    checkSection: (schema, value, what) => checkSection(schema, value, what),
    async resolve({ projectPath, detected = {} } = {}): Promise<ResolvedSettings> {
      const values = new Map<string, { value: unknown; source: SettingSource }>();
      for (const def of defs.values())
        values.set(def.key, { value: def.default, source: "default" });
      for (const [key, value] of Object.entries(detected)) {
        if (!defs.has(key)) throw new Error(`A module detected "${key}", which no module declares`);
        values.set(key, { value, source: "detected" });
      }
      // Later layers win (R17.2). Run or workspace overrides will go after the local override.
      const layers: Layer[] = [];
      const global = await readGlobal(globalPath);
      if (global) layers.push({ file: global, source: "global", code: "bad_settings" });
      const files = projectPath ? await configFiles(projectPath) : {};
      if (files.project)
        layers.push({ file: files.project, source: "project file", code: "bad_project_config" });
      if (files.local)
        layers.push({ file: files.local, source: "local override", code: "bad_project_config" });
      for (const layer of layers)
        for (const [key, value] of read(layer)) values.set(key, { value, source: layer.source });

      return {
        get: (def) => {
          const found = values.get(def.key);
          if (!found) throw new Error(`Setting "${def.key}" is not declared`);
          return found as { value: Static<typeof def.schema>; source: SettingSource };
        },
        entries: (): SettingEntry[] =>
          [...values]
            .map(([key, { value, source }]) => ({ key, value, source }))
            .sort((a, b) => a.key.localeCompare(b.key)),
      };
    },
  };
  return {
    ...settings,
    async finishDeclaring() {
      declaring = false;
      await settings.resolve();
    },
  };
}
