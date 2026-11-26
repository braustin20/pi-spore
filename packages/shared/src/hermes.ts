import Type, { type Static } from "typebox";

/**
 * What the Hermes connector knows now (ADR 0202). `disabled` means `hermes.enabled` is off and nothing was sent.
 * `detail` names the URL, the key file path, the versions, or the flags; it never holds the key.
 */
export const HermesStatus = Type.Union([
  Type.Object({ state: Type.Literal("disabled") }),
  Type.Object({
    state: Type.Union([
      Type.Literal("unreachable"),
      Type.Literal("unauthorized"),
      Type.Literal("incompatible"),
    ]),
    detail: Type.String(),
    checkedAt: Type.Integer(),
  }),
  Type.Object({
    state: Type.Literal("ready"),
    version: Type.String(),
    url: Type.String(),
    profile: Type.String(),
    checkedAt: Type.Integer(),
  }),
]);
export type HermesStatus = Static<typeof HermesStatus>;
