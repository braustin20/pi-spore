import Type, { type Static } from "typebox";

/** How pi-spore saw an editor: `unity status`, a process with `-projectpath`, the lock file, or only its own lease
 * of an editor that is still starting. */
export const EditorSource = Type.Union([
  Type.Literal("status"),
  Type.Literal("process"),
  Type.Literal("lockfile"),
  Type.Literal("lease"),
]);
export type EditorSource = Static<typeof EditorSource>;

/** A Unity editor open on the project's main checkout or one of its workspaces. */
export const OpenEditor = Type.Object({
  path: Type.String(),
  /** The workspace whose folder it has open; absent for the main checkout. */
  workspaceId: Type.Optional(Type.String()),
  pid: Type.Optional(Type.Integer()),
  /** From `unity status`, such as `ready`; `starting` for a lease not yet seen. */
  state: Type.Optional(Type.String()),
  seenBy: Type.Array(EditorSource),
});
export type OpenEditor = Static<typeof OpenEditor>;

/** Who holds the one editor of a project (R10.4). */
export const EditorLease = Type.Object({
  projectId: Type.String(),
  path: Type.String(),
  workspaceId: Type.Optional(Type.String()),
  owner: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
  openedAt: Type.Integer(),
  seenAt: Type.Optional(Type.Integer()),
});
export type EditorLease = Static<typeof EditorLease>;

export const ProjectEditors = Type.Object({
  editors: Type.Array(OpenEditor),
  /** Folders with `Temp/UnityLockfile` but no running editor, such as after a crash. They do not block. */
  staleLocks: Type.Array(Type.String()),
  lease: Type.Optional(EditorLease),
  /** Sources that could not be read, such as a failed `unity status`. */
  warnings: Type.Array(Type.String()),
});
export type ProjectEditors = Static<typeof ProjectEditors>;

export const UnityWorkspaceView = Type.Union([
  Type.Object({ unity: Type.Literal(false) }),
  Type.Object({
    unity: Type.Literal(true),
    editorVersion: Type.String(),
    editors: ProjectEditors,
  }),
]);
export type UnityWorkspaceView = Static<typeof UnityWorkspaceView>;

export const OpenUnityResponse = Type.Object({
  lease: EditorLease,
  /** The editor already had this folder open, so nothing was started. */
  alreadyOpen: Type.Boolean(),
});
export type OpenUnityResponse = Static<typeof OpenUnityResponse>;

/** `unity close` exits without saving, so the request must carry the user's explicit yes (R10.5). */
export const CloseEditorRequest = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    confirm: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type CloseEditorRequest = Static<typeof CloseEditorRequest>;
