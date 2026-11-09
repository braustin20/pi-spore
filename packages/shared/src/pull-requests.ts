import Type, { type Static } from "typebox";

export const PrCheckState = Type.Union([
  Type.Literal("pending"),
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("cancelled"),
  Type.Literal("skipped"),
  Type.Literal("neutral"),
]);
export type PrCheckState = Static<typeof PrCheckState>;

/** One check on the PR's head commit: a CI job or a commit status. */
export const PrCheck = Type.Object({
  name: Type.String(),
  /** The workflow a GitHub Actions job belongs to. */
  workflow: Type.Optional(Type.String()),
  state: PrCheckState,
  url: Type.Optional(Type.String()),
});
export type PrCheck = Static<typeof PrCheck>;

export const PrState = Type.Union([
  Type.Literal("open"),
  Type.Literal("closed"),
  Type.Literal("merged"),
]);
export type PrState = Static<typeof PrState>;

export const PrReview = Type.Union([
  Type.Literal("approved"),
  Type.Literal("changes_requested"),
  Type.Literal("review_required"),
  Type.Literal("none"),
]);
export type PrReview = Static<typeof PrReview>;

export const PrMergeable = Type.Union([
  Type.Literal("mergeable"),
  Type.Literal("conflicting"),
  Type.Literal("unknown"),
]);
export type PrMergeable = Static<typeof PrMergeable>;

/** A pull request as pi-spore last saw it on GitHub. */
export const PullRequest = Type.Object({
  number: Type.Integer(),
  url: Type.String(),
  title: Type.String(),
  state: PrState,
  draft: Type.Boolean(),
  /** The branch the PR comes from. */
  line: Type.String(),
  /** The branch it goes to. */
  base: Type.String(),
  /** The commit the checks ran on. */
  headId: Type.String(),
  review: PrReview,
  /** Whether it can merge into the base: `conflicting` means conflicts with the base. */
  mergeable: PrMergeable,
  checks: Type.Array(PrCheck),
});
export type PullRequest = Static<typeof PullRequest>;

/**
 * PR watch (R9.2). `watching`: polls and sends failures to the worker. `waiting`: stopped sending after the tries ran
 * out, or for lack of a worker chat, until the user resumes. `done`: the PR is merged or closed.
 */
export const PrWatchState = Type.Union([
  Type.Literal("off"),
  Type.Literal("watching"),
  Type.Literal("waiting"),
  Type.Literal("done"),
]);
export type PrWatchState = Static<typeof PrWatchState>;

/** One automatic message to the worker about the PR. */
export const PrTry = Type.Object({
  at: Type.Integer(),
  headId: Type.String(),
  summary: Type.String(),
});
export type PrTry = Static<typeof PrTry>;

export const PrStatus = Type.Object({
  workspaceId: Type.String(),
  /** The workspace can be published: its provider can push and it has its own line. */
  publishable: Type.Boolean(),
  /** Why it cannot, when it cannot. */
  reason: Type.Optional(Type.String()),
  /** Starting values for the publish form. */
  defaults: Type.Object({
    title: Type.String(),
    body: Type.String(),
    base: Type.Optional(Type.String()),
  }),
  pr: Type.Optional(PullRequest),
  /** Why Merge is off; absent when the PR can merge. */
  mergeBlocked: Type.Optional(Type.String()),
  /** The user chose that the watch merges this PR when it is ready (ADR 0164). */
  mergeWhenReady: Type.Boolean(),
  watch: Type.Object({
    state: PrWatchState,
    tries: Type.Integer(),
    maxTries: Type.Integer(),
    polledAt: Type.Optional(Type.Integer()),
    nextPollAt: Type.Optional(Type.Integer()),
    /** Why the watch waits, or why the last look at GitHub failed. */
    message: Type.Optional(Type.String()),
  }),
  /** Newest first. */
  tries: Type.Array(PrTry),
  local: Type.Object({
    /** The workspace's current commit. */
    headId: Type.Optional(Type.String()),
    /** Uncommitted files, which a push leaves out. */
    uncommitted: Type.Integer(),
  }),
});
export type PrStatus = Static<typeof PrStatus>;

/** Opening a PR pushes the branch, so the request must say it is confirmed (R9.1). */
export const PublishRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ maxLength: 65_536 }),
    /** A branch name; it may not look like an option. */
    base: Type.String({ minLength: 1, maxLength: 255, pattern: "^[^-\\s][^\\s]*$" }),
    draft: Type.Optional(Type.Boolean()),
    confirm: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type PublishRequest = Static<typeof PublishRequest>;

/** A chat asks the user to open its workspace's PR. The user may edit both fields on approve (ADR 0100). */
export const OpenWorkspacePrRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ maxLength: 65_536 }),
  },
  { additionalProperties: false },
);
export type OpenWorkspacePrRequest = Static<typeof OpenWorkspacePrRequest>;

/** A chat pushes its workspace's branch. It names nothing: the branch is the workspace's own (ADR 0164). */
export const PushLineRequest = Type.Object({}, { additionalProperties: false });
export type PushLineRequest = Static<typeof PushLineRequest>;

/** What a `workspace-pr` approval holds. The user may edit `title` and `body` on approve, not the rest. */
export const WorkspacePrSubject = Type.Object(
  {
    workspaceId: Type.String(),
    title: Type.String(),
    body: Type.String(),
    base: Type.String(),
    /** Set by the user on approve only; the chat files the subject without it (ADR 0164). */
    mergeWhenReady: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type WorkspacePrSubject = Static<typeof WorkspacePrSubject>;

export const PushRequest = Type.Object(
  { confirm: Type.Literal(true) },
  { additionalProperties: false },
);
export type PushRequest = Static<typeof PushRequest>;

/** `headId` is the PR head the user saw; GitHub refuses the merge if the head moved (ADR 0142). */
export const MergeRequest = Type.Object(
  { confirm: Type.Literal(true), headId: Type.String({ pattern: "^[0-9a-f]{40,64}$" }) },
  { additionalProperties: false },
);
export type MergeRequest = Static<typeof MergeRequest>;

export const WatchRequest = Type.Object({ on: Type.Boolean() }, { additionalProperties: false });
export type WatchRequest = Static<typeof WatchRequest>;

/** Topic `github-pr:<workspace id>` sends the status on subscribe and after every change. */
export const PrEvent = Type.Object({ type: Type.Literal("status"), status: PrStatus });
export type PrEvent = Static<typeof PrEvent>;
