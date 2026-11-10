import type { SettingEntry, SettingSource } from "@pi-spore/shared";
import type { Static, TSchema } from "typebox";

/** A setting a module declares (R17). Its key is a dotted path, the same in every file. */
export interface SettingDef<S extends TSchema = TSchema> {
  key: string;
  schema: S;
  default: Static<S>;
  /** `global`: only `<home>/settings.json` may set it. `project`: the project file and the local override too. */
  scope: "global" | "project";
}

/** A config file parsed as TOML and checked for model keys (R17.3). Each module checks its own sections. */
export interface RawConfigFile {
  path: string;
  data: Record<string, unknown>;
}

export interface RawConfigFiles {
  /** `<project>/.pi-spore/config.toml` */
  project?: RawConfigFile;
  /** `<project>/.pi-spore/config.local.toml`, which wins over the project file. */
  local?: RawConfigFile;
}

/** The last layer of a resolve: the settings a workspace or a run was made with (R17.2). */
export interface SettingsOverride {
  source: "workspace" | "run";
  values: Readonly<Record<string, unknown>>;
}

export interface ResolvedSettings {
  get<S extends TSchema>(def: SettingDef<S>): { value: Static<S>; source: SettingSource };
  /** Every declared setting, sorted by key. */
  entries(): SettingEntry[];
}

/**
 * Settings from all sources (R17.2, architecture 13): defaults, detected values, `<home>/settings.json`, the project
 * file, the local override, then a workspace or run override. Files are read fresh on each call. A bad file answers
 * 422 `bad_settings` (global) or `bad_project_config` (project), naming the key and the file. A bad override answers
 * 422 `bad_override`.
 */
export interface Settings {
  /** Declares a setting and returns it, to read with `ResolvedSettings.get`. A repeated key throws. */
  declare<const S extends TSchema>(def: SettingDef<S>): SettingDef<S>;
  /** Lets a top-level section of a file pass the unknown-key check, because another owner reads and checks it. */
  reserve(file: "global" | "project", section: string): void;
  /**
   * With `projectPath`, the project's two files count too. `detected` maps keys to values a module found.
   * `override` is the last layer and beats every file. `values` is a nested table like a file. It sets only
   * declared `project` keys, never a reserved section, and never a model key (R17.3).
   */
  resolve(options?: {
    projectPath?: string;
    detected?: Readonly<Record<string, unknown>>;
    override?: SettingsOverride;
  }): Promise<ResolvedSettings>;
  /** The project file and the local override, parsed and checked for model keys, sections not yet checked. */
  configFiles(projectPath: string): Promise<RawConfigFiles>;
  /** Checks one section of a config file against its schema; a mismatch answers 422 `bad_project_config`. */
  checkSection<const S extends TSchema>(schema: S, value: unknown, what: string): Static<S>;
  /**
   * Saves one change to settings.json (`global`) or the project's config.local.toml (`local`), never config.toml
   * (ADR 0170). `key` is a declared key, or a key inside a reserved section of that file; the owner of a reserved
   * section passes `check`. Unset deletes the key, so the next layer applies. The whole new file is checked like a
   * resolve, then `check` runs; a failure answers 422 `bad_settings` or `bad_project_config` naming the key and the
   * file, and the file is left as it was.
   */
  write(
    target: { file: "global" } | { file: "local"; projectPath: string },
    key: string,
    change: { value: unknown } | { unset: true },
    check?: (data: Record<string, unknown>, path: string) => void | Promise<void>,
  ): Promise<void>;
}
