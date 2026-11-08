import Type, { type Static } from "typebox";

export const JobState = Type.Union([
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("interrupted"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
]);
export type JobState = Static<typeof JobState>;

/** A durable job of the runner (ADR 0004). `subject` is whatever the module that owns the kind started it with. */
export const Job = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  key: Type.Union([Type.String(), Type.Null()]),
  subject: Type.Unknown(),
  state: JobState,
  step: Type.String(),
  attempts: Type.Integer(),
  error: Type.Union([Type.String(), Type.Null()]),
  runAt: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type Job = Static<typeof Job>;

export const JobList = Type.Object({ jobs: Type.Array(Job) });
export type JobList = Static<typeof JobList>;
