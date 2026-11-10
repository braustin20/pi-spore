import Type, { type Static } from "typebox";

/** Something a module detected about a project, such as `{ id: "unity", detail: "6000.3.10f1" }`. */
export const ProjectTrait = Type.Object({
  id: Type.String(),
  detail: Type.Optional(Type.String()),
});
export type ProjectTrait = Static<typeof ProjectTrait>;

export const Project = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** Short, path-safe form of the name, used in worktree folders. */
  slug: Type.String(),
  path: Type.String(),
  /** VCS provider kind: `git` or `folder` in v1. */
  vcs: Type.String(),
  traits: Type.Array(ProjectTrait),
  createdAt: Type.Integer(),
});
export type Project = Static<typeof Project>;

export const ProjectList = Type.Object({ projects: Type.Array(Project) });
export type ProjectList = Static<typeof ProjectList>;

export const AddProjectRequest = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  },
  { additionalProperties: false },
);
export type AddProjectRequest = Static<typeof AddProjectRequest>;

/** Where a resolved setting came from (R17.1). */
export const SettingSource = Type.Union([
  Type.Literal("default"),
  Type.Literal("detected"),
  Type.Literal("project file"),
  Type.Literal("local override"),
  Type.Literal("global"),
  Type.Literal("workspace"),
  Type.Literal("run"),
]);
export type SettingSource = Static<typeof SettingSource>;

export const ProjectConfigView = Type.Object({
  worktreeCopy: Type.Object({ value: Type.Array(Type.String()), source: SettingSource }),
  branchPrefix: Type.Object({ value: Type.String(), source: SettingSource }),
});
export type ProjectConfigView = Static<typeof ProjectConfigView>;

/** One resolved setting and where its value came from (R17.1). */
export const SettingEntry = Type.Object({
  /** Dotted path, the same in every file: `agents.maxLive`. */
  key: Type.String(),
  value: Type.Unknown(),
  source: SettingSource,
});
export type SettingEntry = Static<typeof SettingEntry>;

/** Every setting with its source, from `~/.pi-spore/settings.json` and the defaults. */
export const SettingsView = Type.Object({ settings: Type.Array(SettingEntry) });
export type SettingsView = Static<typeof SettingsView>;

/** One setting change from the Settings page (ADR 0170): set `key` to `value`, or unset it. */
export const SaveSettingRequest = Type.Union([
  Type.Object(
    { key: Type.String({ minLength: 1 }), value: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { key: Type.String({ minLength: 1 }), unset: Type.Literal(true) },
    { additionalProperties: false },
  ),
]);
export type SaveSettingRequest = Static<typeof SaveSettingRequest>;

/** The saved key, resolved again, with its new source. */
export const SaveSettingResponse = Type.Object({ setting: SettingEntry });
export type SaveSettingResponse = Static<typeof SaveSettingResponse>;

/** A nested table like the settings files; only project keys; checked by the resolver (R17.2). */
export const SettingsOverrideValues = Type.Record(Type.String(), Type.Unknown());

export const ProjectLines = Type.Object({
  lines: Type.Array(Type.String()),
  current: Type.Optional(Type.String()),
});
export type ProjectLines = Static<typeof ProjectLines>;
