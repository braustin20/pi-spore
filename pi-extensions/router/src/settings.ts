import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

/** `PI_SPORE_HOME` overrides `~/.pi-spore`, as for the server. */
export function sporeHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.PI_SPORE_HOME ?? join(homedir(), ".pi-spore");
}

export const TIERS = ["local", "light", "medium", "heavy"] as const;
export type Tier = (typeof TIERS)[number];

/** `provider/id`. The id may contain slashes (`openrouter/~typesafe/jev-latest`). */
const ModelRef = Type.String({ pattern: "^[^/\\s]+/\\S+$" });
const TierSchema = Type.Union(TIERS.map((tier) => Type.Literal(tier)));
const Fraction = Type.Number({ minimum: 0, maximum: 1 });

const LocalTarget = Type.Object(
  {
    model: ModelRef,
    contextWindow: Type.Integer({ minimum: 1 }),
    /** Share of the context window the brief, the named files, and the conversation may fill. */
    budget: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    /** Sessions that may use the target at once (ADR 0010). */
    concurrency: Type.Integer({ minimum: 1 }),
    /** Answers 2xx when the target can take requests. Checked before a local route. */
    healthUrl: Type.Optional(Type.String({ pattern: "^https?://" })),
  },
  { additionalProperties: false },
);

const RouterSection = Type.Object(
  {
    classifier: Type.Optional(ModelRef),
    cloud: Type.Optional(ModelRef),
    localTargets: Type.Optional(Type.Array(LocalTarget, { minItems: 1 })),
    threshold: Type.Optional(Fraction),
    pressureThreshold: Type.Optional(Fraction),
    pressure: Type.Optional(
      Type.Object(
        { weekly: Type.Optional(Fraction), fiveHour: Type.Optional(Fraction) },
        { additionalProperties: false },
      ),
    ),
    usageMaxAgeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    spill: Type.Optional(Type.Array(ModelRef)),
    plans: Type.Optional(Type.Record(Type.String(), Type.String({ pattern: "^[a-z0-9-]+$" }))),
  },
  { additionalProperties: false },
);

/** The parts of `~/.pi-spore/settings.json` the router reads. Other keys belong to the server. */
const SettingsFile = Type.Object({
  router: Type.Optional(RouterSection),
  tiers: Type.Optional(Type.Record(Type.String(), TierSchema)),
});

export type LocalTarget = Static<typeof LocalTarget>;

export interface RouterSettings {
  /** Classifier model for the routing questions (ADR 0009). */
  classifier: string;
  /** Cloud model for tasks that do not go local. Unset: the pi-subagents `worker` model. */
  cloud: string | undefined;
  localTargets: LocalTarget[];
  /** Least probability of every "good" Jev answer for a local route (ADR 0024). */
  threshold: number;
  /** The same under usage pressure. The visual question keeps `threshold`. */
  pressureThreshold: number;
  /** Claude usage pressure: weekly above `weekly`, or 5-hour at or above `fiveHour` (R4.10). */
  pressure: { weekly: number; fiveHour: number };
  /** A plan window seen longer ago than this is stale (R18.5). */
  usageMaxAgeMinutes: number;
  /** Models the router may spill to when the cloud model's plan is full; one per tier (ADR 0024). */
  spill: string[];
  /** Which subscription plan a provider draws on. Providers not listed have no plan window. */
  plans: Record<string, string>;
  /** Model strength order (ADR 0023), by `provider/id`. */
  tiers: Record<string, Tier>;
}

export const DEFAULT_TIERS: Readonly<Record<string, Tier>> = {
  "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs": "local",
  "claude-bridge/claude-haiku-5-5": "light",
  "anthropic/claude-haiku-5-5": "light",
  "openai/gpt-6-luna": "light",
  "openai-codex/gpt-6-luna": "light",
  "claude-bridge/claude-sonnet-5-5": "medium",
  "anthropic/claude-sonnet-5-5": "medium",
  "openai/gpt-6.1-terra": "medium",
  "openai-codex/gpt-6.1-terra": "medium",
  "claude-bridge/claude-opus-5-5": "heavy",
  "anthropic/claude-opus-5-5": "heavy",
  "openai/gpt-6.1-sol": "heavy",
  "openai-codex/gpt-6.1-sol": "heavy",
};

export const DEFAULT_SETTINGS: Readonly<RouterSettings> = {
  classifier: "openrouter/~typesafe/jev-latest",
  cloud: undefined,
  localTargets: [
    {
      model: "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs",
      contextWindow: 131_072,
      budget: 0.5,
      concurrency: 1,
      healthUrl: "http://127.0.0.1:8080/health",
    },
  ],
  threshold: 0.7,
  pressureThreshold: 0.55,
  pressure: { weekly: 0.75, fiveHour: 1 },
  usageMaxAgeMinutes: 60,
  spill: ["openai/gpt-6-luna", "openai/gpt-6.1-terra", "openai/gpt-6.1-sol"],
  plans: {
    "claude-bridge": "claude",
    anthropic: "claude",
    openai: "codex",
    "openai-codex": "codex",
  },
  tiers: { ...DEFAULT_TIERS },
};

/** Checks a value from outside the process and throws a readable error if it is wrong. */
export function parse<const S extends TSchema>(schema: S, value: unknown, what: string): Static<S> {
  if (Check(schema, value)) return value;
  const details = Errors(schema, value)
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid ${what}: ${details}`);
}

/** Built-in defaults overlaid by the file's values. A missing file means the defaults. */
export function resolveSettings(file: unknown, path: string): RouterSettings {
  const { router = {}, tiers = {} } = parse(SettingsFile, file, path);
  return {
    classifier: router.classifier ?? DEFAULT_SETTINGS.classifier,
    cloud: router.cloud ?? DEFAULT_SETTINGS.cloud,
    localTargets: router.localTargets ?? DEFAULT_SETTINGS.localTargets,
    threshold: router.threshold ?? DEFAULT_SETTINGS.threshold,
    pressureThreshold: router.pressureThreshold ?? DEFAULT_SETTINGS.pressureThreshold,
    pressure: { ...DEFAULT_SETTINGS.pressure, ...router.pressure },
    usageMaxAgeMinutes: router.usageMaxAgeMinutes ?? DEFAULT_SETTINGS.usageMaxAgeMinutes,
    spill: router.spill ?? DEFAULT_SETTINGS.spill,
    plans: { ...DEFAULT_SETTINGS.plans, ...router.plans },
    tiers: { ...DEFAULT_TIERS, ...tiers },
  };
}

export async function loadSettings(home: string): Promise<RouterSettings> {
  const path = join(home, "settings.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveSettings({}, path);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  return resolveSettings(value, path);
}

/** Splits `provider/id` at the first slash. */
export function splitModel(ref: string): { provider: string; id: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`${ref} is not provider/id`);
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** The tier of a model. A model with no tier is an error at the point of use (ADR 0023). */
export function tierOf(settings: RouterSettings, ref: string): Tier {
  const tier = settings.tiers[ref];
  if (!tier) throw new Error(`${ref} has no tier; add it to "tiers" in settings.json`);
  return tier;
}
