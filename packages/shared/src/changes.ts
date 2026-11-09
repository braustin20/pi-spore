import Type, { type Static } from "typebox";

/**
 * Which changes of a workspace to show (R8.1). Neutral words (ADR 0005): a "record" is a commit and a "line" is a
 * branch. `uncommitted`: the working copy against the last record, new files included. `staged`: what the next
 * record would hold. `line`: every record on the line since it left its base. `record`: one record.
 */
export const ChangeScopeKind = Type.Union([
  Type.Literal("uncommitted"),
  Type.Literal("staged"),
  Type.Literal("line"),
  Type.Literal("record"),
]);
export type ChangeScopeKind = Static<typeof ChangeScopeKind>;

export const ChangeScope = Type.Union([
  Type.Object({ kind: Type.Literal("uncommitted") }),
  Type.Object({ kind: Type.Literal("staged") }),
  Type.Object({ kind: Type.Literal("line"), base: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("record"), id: Type.String({ minLength: 1 }) }),
]);
export type ChangeScope = Static<typeof ChangeScope>;

export const ChangeStatus = Type.Union([
  Type.Literal("added"),
  Type.Literal("modified"),
  Type.Literal("deleted"),
  Type.Literal("renamed"),
]);
export type ChangeStatus = Static<typeof ChangeStatus>;

export const ChangedFile = Type.Object({
  path: Type.String(),
  /** For a rename: the path before. */
  oldPath: Type.Optional(Type.String()),
  status: ChangeStatus,
  additions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
  binary: Type.Boolean(),
});
export type ChangedFile = Static<typeof ChangedFile>;

export const DiffLineKind = Type.Union([
  Type.Literal("context"),
  Type.Literal("add"),
  Type.Literal("del"),
]);
export type DiffLineKind = Static<typeof DiffLineKind>;

export const DiffLine = Type.Object({
  kind: DiffLineKind,
  /** Line number on the old side; missing for an added line. */
  oldLine: Type.Optional(Type.Integer()),
  /** Line number on the new side; missing for a deleted line. */
  newLine: Type.Optional(Type.Integer()),
  text: Type.String(),
  /** The side has no newline after this line. */
  noNewline: Type.Optional(Type.Boolean()),
});
export type DiffLine = Static<typeof DiffLine>;

export const DiffHunk = Type.Object({
  oldStart: Type.Integer(),
  newStart: Type.Integer(),
  /** The text after the second `@@`, usually the enclosing function. */
  section: Type.String(),
  lines: Type.Array(DiffLine),
});
export type DiffHunk = Static<typeof DiffHunk>;

/** Why a file's diff is not shown: a binary file, or one too large to show. */
export const DiffNote = Type.Union([Type.Literal("binary"), Type.Literal("too_large")]);
export type DiffNote = Static<typeof DiffNote>;

export const FileDiff = Type.Object({
  file: ChangedFile,
  hunks: Type.Array(DiffHunk),
  note: Type.Optional(DiffNote),
});
export type FileDiff = Static<typeof FileDiff>;

/** A record (commit) on the workspace's line. */
export const ChangeRecord = Type.Object({
  id: Type.String(),
  shortId: Type.String(),
  subject: Type.String(),
  author: Type.String(),
  /** Epoch milliseconds. */
  at: Type.Integer(),
});
export type ChangeRecord = Static<typeof ChangeRecord>;

/** What the Changes tab can show for a workspace. */
export const ChangesSummary = Type.Object({
  scopes: Type.Array(ChangeScopeKind),
  /** The base `line` changes are measured from; missing when the provider knows none. */
  base: Type.Optional(Type.String()),
  /** Records on the line since the base, newest first; the last 50 records when there is no base. */
  records: Type.Array(ChangeRecord),
});
export type ChangesSummary = Static<typeof ChangesSummary>;

export const ChangedFileList = Type.Object({
  files: Type.Array(ChangedFile),
  /** More files changed than the list holds. */
  truncated: Type.Boolean(),
});
export type ChangedFileList = Static<typeof ChangedFileList>;

export const DiffList = Type.Object({
  diffs: Type.Array(FileDiff),
  /** More files changed than the answer holds. */
  truncated: Type.Boolean(),
});
export type DiffList = Static<typeof DiffList>;

export const CommentSide = Type.Union([Type.Literal("old"), Type.Literal("new")]);
export type CommentSide = Static<typeof CommentSide>;

/** A comment on one diff line, for the worker (R8.3). */
export const DiffComment = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  path: Type.String(),
  side: CommentSide,
  line: Type.Integer({ minimum: 1 }),
  /** The line's text when the comment was written. */
  code: Type.String(),
  body: Type.String(),
  createdAt: Type.Integer(),
  /** In the chat composer's batch: it goes with the next message the user sends (R8.3). */
  staged: Type.Boolean(),
  /** When it went to the worker. Sent comments leave the open list. */
  sentAt: Type.Optional(Type.Integer()),
});
export type DiffComment = Static<typeof DiffComment>;

export const DiffCommentList = Type.Object({ comments: Type.Array(DiffComment) });
export type DiffCommentList = Static<typeof DiffCommentList>;

export const CreateCommentRequest = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    side: CommentSide,
    line: Type.Integer({ minimum: 1 }),
    code: Type.String({ maxLength: 2000 }),
    body: Type.String({ minLength: 1, maxLength: 10_000 }),
  },
  { additionalProperties: false },
);
export type CreateCommentRequest = Static<typeof CreateCommentRequest>;

export const StageCommentsRequest = Type.Object(
  {
    staged: Type.Boolean(),
    /** Without ids, every open comment of the workspace. */
    ids: Type.Optional(Type.Array(Type.String(), { maxItems: 1000 })),
  },
  { additionalProperties: false },
);
export type StageCommentsRequest = Static<typeof StageCommentsRequest>;

export const SendCommentsResponse = Type.Object({
  /** The worker chat that got them. */
  agentId: Type.String(),
  comments: Type.Array(DiffComment),
});
export type SendCommentsResponse = Static<typeof SendCommentsResponse>;

/** Events on topic `changes:<workspace id>`. */
export const ChangesEvent = Type.Union([
  /** The workspace's files may have changed, such as when the worker's run ended. */
  Type.Object({ type: Type.Literal("stale") }),
  Type.Object({ type: Type.Literal("comments"), comments: Type.Array(DiffComment) }),
]);
export type ChangesEvent = Static<typeof ChangesEvent>;
