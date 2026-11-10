import type { Settings } from "@pi-spore/module-api";
import Type from "typebox";

const MIB = 1024 * 1024;

/**
 * The agents module's settings (R3.6, ADR 0026, ADR 0060). They apply when the server starts.
 * `maxSubagentDepth` goes to every agent process as PI_SUBAGENT_MAX_DEPTH; 0 allows no helpers (ADR 0167).
 */
export function declareAgentSettings(settings: Settings) {
  const count = (key: string, fallback: number, minimum = 1) =>
    settings.declare({
      key,
      schema: Type.Integer({ minimum }),
      default: fallback,
      scope: "global",
    });
  return {
    maxLive: count("agents.maxLive", 8),
    idleStopMinutes: count("agents.idleStopMinutes", 10),
    maxImageBytes: count("agents.maxImageBytes", 10 * MIB),
    maxImagesPerMessage: count("agents.maxImagesPerMessage", 8),
    maxSubagentDepth: count("agents.maxSubagentDepth", 2, 0),
  };
}
