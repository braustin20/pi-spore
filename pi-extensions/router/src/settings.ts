import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import Type, { type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

/** `PI_SPORE_HOME` overrides `~/.pi-spore`, as for the server. */
export function sporeHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.PI_SPORE_HOME ?? join(homedir(), ".pi-spore");
}

export const TIERS = ["local", "light", "medium", "heavy", "top"] as const;
export type Tier = (typeof TIERS)[number];

/** `provider/id`. The id may contain slashes (`openrouter/~typesafe/jev-latest`). */
const ModelRef = Type.String({ pattern: "^[^/\\s]+/\\S+$" });
const TierSchema = Type.Union(TIERS.map((tier) => Type.Literal(tier)));
const Fraction = Type.Number({ minimum: 0, maximum: 1 });

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
/** Narrowed to the levels pi-ai takes, so a value can be passed on as is. */
export type ThinkingLevel = Static<typeof ThinkingLevelSchema> & ModelThinkingLevel;

const LadderEntry = Type.Object(
  { model: ModelRef, thinking: ThinkingLevelSchema },
  { additionalProperties: false },
);

/** A plan's three models, cheapest first (ADR 0141). `plan` names the usage file. */
const Ladder = Type.Object(
  {
    plan: Type.String({ pattern: "^[a-z0-9-]+$" }),
    rungs: Type.Array(LadderEntry, { minItems: 3, maxItems: 3 }),
  },
  { additionalProperties: false },
);

const LocalTarget = Type.Object(
  {
    model: ModelRef,
    /** The level the router uses for the target. The level the user picked for `spore/auto` has no effect. */
    thinking: ThinkingLevelSchema,
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
    ladders: Type.Optional(Type.Array(Ladder, { minItems: 1 })),
    localTargets: Type.Optional(Type.Array(LocalTarget, { minItems: 1 })),
    threshold: Type.Optional(Fraction),
    heavyThreshold: Type.Optional(Fraction),
    large: Type.Optional(Type.Integer({ minimum: 1 })),
    maxQueued: Type.Optional(Type.Integer({ minimum: 0 })),
    explore: Type.Optional(Fraction),
    pressureThreshold: Type.Optional(Fraction),
    pressure: Type.Optional(
      Type.Object(
        { weekly: Type.Optional(Fraction), fiveHour: Type.Optional(Fraction) },
        { additionalProperties: false },
      ),
    ),
    usageMaxAgeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
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
export type LadderEntry = Static<typeof LadderEntry>;
export type Ladder = Static<typeof Ladder>;

export interface RouterSettings {
  /** Classifier model for the routing questions (ADR 0009). */
  classifier: string;
  /** Cloud plans in order of preference. The task goes to the first plan that is not full (ADR 0141). */
  ladders: Ladder[];
  localTargets: LocalTarget[];
  /** Least probability of every cheap "good" Jev answer for rung 1 (ADR 0024, 0141). */
  threshold: number;
  /** Rung 3 when a good answer of visual, design, or foundational is below this. Pressure never lowers it. */
  heavyThreshold: number;
  /** Rung 3 when the token estimate is above this. */
  large: number;
  /** Most sessions that may wait for a busy local target; more go to the cloud (ADR 0141). */
  maxQueued: number;
  /** Chance a pipeline worker task goes local when "straightforward" or "visual" is its only blocker (ADR 0144, 0173). */
  explore: number;
  /** The same under usage pressure. The visual question keeps `threshold`. */
  pressureThreshold: number;
  /** Claude usage pressure: weekly above `weekly`, or 5-hour at or above `fiveHour` (R4.10). */
  pressure: { weekly: number; fiveHour: number };
  /** A plan window seen longer ago than this is stale (R18.5). */
  usageMaxAgeMinutes: number;
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
  "openrouter/openai/gpt-6-luna": "light",
  "claude-bridge/claude-sonnet-5-5": "medium",
  "anthropic/claude-sonnet-5-5": "medium",
  "openrouter/deepseek/deepseek-v4.1-flash-1017": "medium",
  "claude-bridge/claude-opus-5-5": "heavy",
  "anthropic/claude-opus-5-5": "heavy",
  "openai/gpt-6.1-sol": "heavy",
  "openai-codex/gpt-6.1-sol": "heavy",
  "openrouter/openai/gpt-6.1-sol": "heavy",
  "openai/gpt-6-astra": "heavy",
  "openai-codex/gpt-6-astra": "heavy",
  "claude-bridge/claude-fable-5-1": "top",
  "anthropic/claude-fable-5-1": "top",
};

export const DEFAULT_SETTINGS: Readonly<RouterSettings> = {
  classifier: "openrouter/~typesafe/jev-latest",
  ladders: [
    {
      plan: "claude",
      rungs: [
        { model: "claude-bridge/claude-haiku-5-5", thinking: "high" },
        { model: "claude-bridge/claude-sonnet-5-5", thinking: "high" },
        { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
      ],
    },
    {
      plan: "codex",
      rungs: [
        { model: "openai/gpt-6-luna", thinking: "xhigh" },
        { model: "openai/gpt-6.1-sol", thinking: "high" },
        { model: "openai/gpt-6-astra", thinking: "high" },
      ],
    },
    {
      plan: "openrouter",
      rungs: [
        { model: "openrouter/openai/gpt-6-luna", thinking: "xhigh" },
        { model: "openrouter/deepseek/deepseek-v4.1-flash-1017", thinking: "high" },
        { model: "openrouter/openai/gpt-6.1-sol", thinking: "high" },
      ],
    },
  ],
  localTargets: [
    {
      model: "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs",
      thinking: "high",
      contextWindow: 131_072,
      budget: 0.5,
      concurrency: 1,
      healthUrl: "http://127.0.0.1:8080/health",
    },
  ],
  threshold: 0.7,
  heavyThreshold: 0.7,
  large: 100_000,
  maxQueued: 1,
  explore: 0,
  pressureThreshold: 0.55,
  pressure: { weekly: 0.75, fiveHour: 1 },
  usageMaxAgeMinutes: 60,
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
  const rawRouter = (file as { router?: unknown } | null)?.router;
  if (typeof rawRouter === "object" && rawRouter !== null) {
    for (const key of ["cloud", "spill"]) {
      if (key in rawRouter) {
        throw new Error(
          `"router.${key}" was replaced by "router.ladders" (ADR 0141); remove it from ${path}`,
        );
      }
    }
  }
  const { router = {}, tiers = {} } = parse(SettingsFile, file, path);
  const settings: RouterSettings = {
    classifier: router.classifier ?? DEFAULT_SETTINGS.classifier,
    ladders: router.ladders ?? DEFAULT_SETTINGS.ladders,
    localTargets: router.localTargets ?? DEFAULT_SETTINGS.localTargets,
    threshold: router.threshold ?? DEFAULT_SETTINGS.threshold,
    heavyThreshold: router.heavyThreshold ?? DEFAULT_SETTINGS.heavyThreshold,
    large: router.large ?? DEFAULT_SETTINGS.large,
    maxQueued: router.maxQueued ?? DEFAULT_SETTINGS.maxQueued,
    explore: router.explore ?? DEFAULT_SETTINGS.explore,
    pressureThreshold: router.pressureThreshold ?? DEFAULT_SETTINGS.pressureThreshold,
    pressure: { ...DEFAULT_SETTINGS.pressure, ...router.pressure },
    usageMaxAgeMinutes: router.usageMaxAgeMinutes ?? DEFAULT_SETTINGS.usageMaxAgeMinutes,
    plans: { ...DEFAULT_SETTINGS.plans, ...router.plans },
    tiers: { ...DEFAULT_TIERS, ...tiers },
  };
  checkRoutable(settings, path);
  return settings;
}

/** The router never routes to `spore/auto` (it would loop) or to a `top` model (ADR 0141). */
function checkRoutable(settings: RouterSettings, path: string): void {
  const check = (setting: string, model: string) => {
    if (model === "spore/auto") {
      throw new Error(`${setting} is spore/auto; the router cannot route to itself in ${path}`);
    }
    if (settings.tiers[model] === "top") {
      throw new Error(
        `${setting} ${model} is tier top; the router never routes to a top model (ADR 0141) in ${path}`,
      );
    }
  };
  settings.localTargets.forEach((target, i) => {
    check(`router.localTargets[${i}].model`, target.model);
  });
  settings.ladders.forEach((ladder, i) => {
    ladder.rungs.forEach((entry, j) => {
      check(`router.ladders[${i}].rungs[${j}].model`, entry.model);
    });
  });
}

/** The parsed file, or `{}` when it does not exist. */
async function readSettingsFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

export async function loadSettings(home: string): Promise<RouterSettings> {
  const path = join(home, "settings.json");
  return resolveSettings(await readSettingsFile(path), path);
}

export interface RouterSettingEntry {
  key: string;
  value: unknown;
  source: "global" | "default";
}

/** Every router setting with its resolved value, for the settings page (R17.1). */
export async function routerSettingEntries(home: string): Promise<RouterSettingEntry[]> {
  const path = join(home, "settings.json");
  const file = (await readSettingsFile(path)) as {
    router?: Record<string, unknown>;
    tiers?: unknown;
  };
  const { tiers, ...router } = resolveSettings(file, path);
  const fromFile = (name: string) => file.router?.[name] !== undefined;
  return [
    ...Object.entries(router).map(([name, value]) => ({
      key: `router.${name}`,
      value,
      source: fromFile(name) ? ("global" as const) : ("default" as const),
    })),
    { key: "tiers", value: tiers, source: file.tiers !== undefined ? "global" : "default" },
  ];
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
