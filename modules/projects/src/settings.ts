import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "@pi-spore/module-api";
import type { GlobalSettingsView } from "@pi-spore/shared";
import Type from "typebox";
import { Check } from "typebox/value";

export const DEFAULT_RETENTION_DAYS = 30;

/** The part of `<home>/settings.json` this module reads. The router reads `router` and `tiers` from the same file. */
const SettingsFile = Type.Object(
  {
    retention: Type.Optional(
      Type.Object(
        { days: Type.Optional(Type.Integer({ minimum: 0 })) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

/** Reads the global settings fresh, so an edit applies without a restart (ADR 0121). */
export async function readGlobalSettings(home: string): Promise<GlobalSettingsView> {
  const path = join(home, "settings.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { retentionDays: { value: DEFAULT_RETENTION_DAYS, source: "default" } };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(422, "bad_settings", `${path} is not valid JSON (retention.days not read)`);
  }
  if (!Check(SettingsFile, value)) {
    throw new ApiError(
      422,
      "bad_settings",
      `${path}: retention.days must be a whole number, 0 or more`,
    );
  }
  const days = value.retention?.days;
  return days === undefined
    ? { retentionDays: { value: DEFAULT_RETENTION_DAYS, source: "default" } }
    : { retentionDays: { value: days, source: "global" } };
}
