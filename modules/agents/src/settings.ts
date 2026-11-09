import type { Settings } from "@pi-spore/module-api";
import Type from "typebox";

const MIB = 1024 * 1024;

/** The agents module's settings (R3.6, ADR 0026, ADR 0060). They apply when the server starts. */
export function declareAgentSettings(settings: Settings) {
  const count = (key: string, fallback: number) =>
    settings.declare({
      key,
      schema: Type.Integer({ minimum: 1 }),
      default: fallback,
      scope: "global",
    });
  return {
    maxLive: count("agents.maxLive", 8),
    idleStopMinutes: count("agents.idleStopMinutes", 10),
    maxImageBytes: count("agents.maxImageBytes", 10 * MIB),
    maxImagesPerMessage: count("agents.maxImagesPerMessage", 8),
  };
}
