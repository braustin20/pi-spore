import Type, { type Static } from "typebox";

/** Where an artifact lives (ADR 0070): with one workspace, or with its project. */
export const ArtifactScope = Type.Union([Type.Literal("workspace"), Type.Literal("project")]);
export type ArtifactScope = Static<typeof ArtifactScope>;

export const ArtifactInfo = Type.Object({
  scope: ArtifactScope,
  /** The workspace id or project id the folder belongs to. */
  ownerId: Type.String(),
  /** Relative to the owner's folder, with `/` separators. */
  path: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer(),
  /** The agent that wrote the file last. Missing when the user wrote it or it was put there by hand. */
  writtenBy: Type.Optional(Type.String()),
  /** The workspace id the file was promoted from. */
  promotedFrom: Type.Optional(Type.String()),
});
export type ArtifactInfo = Static<typeof ArtifactInfo>;

export const ArtifactList = Type.Object({ artifacts: Type.Array(ArtifactInfo) });
export type ArtifactList = Static<typeof ArtifactList>;

export const WriteArtifactRequest = Type.Object(
  { path: Type.String(), content: Type.String() },
  { additionalProperties: false },
);
export type WriteArtifactRequest = Static<typeof WriteArtifactRequest>;

export const PromoteArtifactRequest = Type.Object(
  { path: Type.String() },
  { additionalProperties: false },
);
export type PromoteArtifactRequest = Static<typeof PromoteArtifactRequest>;

export const OpenArtifactFolderRequest = Type.Object(
  { path: Type.String() },
  { additionalProperties: false },
);
export type OpenArtifactFolderRequest = Static<typeof OpenArtifactFolderRequest>;

/** Whether the browser is on the computer that runs pi-spore, so "open folder" can work. */
export const ArtifactsLocal = Type.Object({ local: Type.Boolean() });
export type ArtifactsLocal = Static<typeof ArtifactsLocal>;

/** The only event of topic `artifacts:<workspace id>`: both lists, on subscribe and after every write. */
export const ArtifactsEvent = Type.Object({
  type: Type.Literal("artifacts"),
  workspace: Type.Array(ArtifactInfo),
  project: Type.Array(ArtifactInfo),
});
export type ArtifactsEvent = Static<typeof ArtifactsEvent>;

/** What `artifacts_list` gets: the files of the calling agent's workspace and of its project. */
export const BridgeArtifactList = Type.Object({
  workspace: Type.Array(ArtifactInfo),
  project: Type.Array(ArtifactInfo),
});
export type BridgeArtifactList = Static<typeof BridgeArtifactList>;

/** What `artifacts_read` gets: the file as text. */
export const BridgeArtifactFile = Type.Object({ artifact: ArtifactInfo, content: Type.String() });
export type BridgeArtifactFile = Static<typeof BridgeArtifactFile>;

/** The owner is the calling agent's workspace or project, never named in the request. */
export const BridgeWriteArtifactRequest = Type.Object(
  { scope: ArtifactScope, path: Type.String(), content: Type.String() },
  { additionalProperties: false },
);
export type BridgeWriteArtifactRequest = Static<typeof BridgeWriteArtifactRequest>;
