import Type, { type Static } from "typebox";

export const HealthResponse = Type.Object({
  status: Type.Literal("ok"),
  version: Type.String(),
  uptimeMs: Type.Integer({ minimum: 0 }),
  /** Enabled module ids in setup order. */
  modules: Type.Array(Type.String()),
});
export type HealthResponse = Static<typeof HealthResponse>;
