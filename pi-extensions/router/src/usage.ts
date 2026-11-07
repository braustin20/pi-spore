import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Type, { type Static } from "typebox";
import { parse } from "./settings.js";

/**
 * Plan windows seen in provider responses (ADR 0022). One file per plan, `<home>/usage/<plan>.json`, replaced with an
 * atomic rename. Each window keeps its own `seenAt`, because one response may report only some windows.
 */
export const WindowSnapshot = Type.Object({
  /** Share of the window used, 0 to 1 (can pass 1 when overage is on). */
  utilization: Type.Number({ minimum: 0 }),
  /** When the window resets, epoch ms. */
  resetsAt: Type.Optional(Type.Number()),
  /** When a response last reported this window, epoch ms. */
  seenAt: Type.Number(),
});

export const PlanSnapshot = Type.Object({
  plan: Type.String({ pattern: "^[a-z0-9-]+$" }),
  /** The plan's own status word, such as Claude's `allowed` or `rejected`. */
  status: Type.Optional(Type.String()),
  /** Which kind of response it came from. */
  source: Type.String(),
  seenAt: Type.Number(),
  /** By window name: `5h`, `7d`, or another length such as `60m`. */
  windows: Type.Record(Type.String(), WindowSnapshot),
});

export type WindowSnapshot = Static<typeof WindowSnapshot>;
export type PlanSnapshot = Static<typeof PlanSnapshot>;

/** Windows parsed from one response, before they are merged into the stored snapshot. */
export interface PlanReading {
  plan: string;
  source: string;
  status?: string;
  windows: Record<string, { utilization: number; resetsAt?: number }>;
}

const CLAUDE_PREFIX = "anthropic-ratelimit-unified-";

function number(value: string, header: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Header ${header} is not a number: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Reset times arrive as epoch seconds; a value that is already in ms is kept. */
const epochMs = (value: number): number => (value < 1e12 ? value * 1000 : value);

/** `5h` and `7d` for the usual lengths, else the length in minutes. */
function windowName(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "7d";
  return minutes === undefined ? fallback : `${minutes}m`;
}

/**
 * Claude's unified rate-limit headers, from the built-in `anthropic` provider or from pi-claude-bridge, which rebuilds
 * them from Claude Code's rate-limit events: `...-status`, `...-<window>-utilization` (0 to 1), `...-<window>-reset`
 * (epoch seconds).
 */
function claudeReading(headers: Readonly<Record<string, string>>): PlanReading | undefined {
  const windows: PlanReading["windows"] = {};
  let status: string | undefined;
  let found = false;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!name.startsWith(CLAUDE_PREFIX)) continue;
    found = true;
    const rest = name.slice(CLAUDE_PREFIX.length);
    if (rest === "status") status = value;
    const match = /^(.+)-utilization$/.exec(rest);
    if (!match?.[1]) continue;
    const window = match[1];
    const reset = Object.entries(headers).find(
      ([other]) => other.toLowerCase() === `${CLAUDE_PREFIX}${window}-reset`,
    );
    windows[window] = {
      utilization: number(value, rawName),
      ...(reset ? { resetsAt: epochMs(number(reset[1], reset[0])) } : {}),
    };
  }
  if (!found) return undefined;
  return {
    plan: "claude",
    source: "anthropic-ratelimit-unified headers",
    ...(status ? { status } : {}),
    windows,
  };
}

/**
 * Codex's headers on the ChatGPT backend (spike Q11): `x-codex-<primary|secondary>-used-percent` (0 to 100),
 * `-window-minutes`, `-reset-at` (epoch seconds).
 */
function codexHeaderReading(headers: Readonly<Record<string, string>>): PlanReading | undefined {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const windows: PlanReading["windows"] = {};
  for (const slot of ["primary", "secondary"]) {
    const used = lower.get(`x-codex-${slot}-used-percent`);
    if (used === undefined) continue;
    const minutes = lower.get(`x-codex-${slot}-window-minutes`);
    const reset = lower.get(`x-codex-${slot}-reset-at`);
    const name = windowName(
      minutes === undefined ? undefined : number(minutes, `x-codex-${slot}-window-minutes`),
      slot,
    );
    windows[name] = {
      utilization: number(used, `x-codex-${slot}-used-percent`) / 100,
      ...(reset === undefined
        ? {}
        : { resetsAt: epochMs(number(reset, `x-codex-${slot}-reset-at`)) }),
    };
  }
  if (Object.keys(windows).length === 0) return undefined;
  return { plan: "codex", source: "x-codex headers", windows };
}

/** Plan windows in one provider response's headers. */
export function readHeaders(headers: Readonly<Record<string, string>>): PlanReading[] {
  return [claudeReading(headers), codexHeaderReading(headers)].filter(
    (reading): reading is PlanReading => reading !== undefined,
  );
}

const CodexEventWindow = Type.Object({
  used_percent: Type.Number({ minimum: 0 }),
  window_minutes: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  reset_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
const CodexRateLimitsEvent = Type.Object({
  type: Type.Literal("codex.rate_limits"),
  rate_limits: Type.Optional(
    Type.Union([
      Type.Object({
        primary: Type.Optional(Type.Union([CodexEventWindow, Type.Null()])),
        secondary: Type.Optional(Type.Union([CodexEventWindow, Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
});

/**
 * Codex's `codex.rate_limits` stream event, which carries the same windows over WebSocket, where there are no
 * response headers (spike Q11). Other events give undefined.
 */
export function readStreamEvent(data: unknown): PlanReading | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if ((data as { type?: unknown }).type !== "codex.rate_limits") return undefined;
  const event = parse(CodexRateLimitsEvent, data, "codex.rate_limits event");
  const windows: PlanReading["windows"] = {};
  for (const slot of ["primary", "secondary"] as const) {
    const window = event.rate_limits?.[slot];
    if (!window) continue;
    windows[windowName(window.window_minutes ?? undefined, slot)] = {
      utilization: window.used_percent / 100,
      ...(typeof window.reset_at === "number" ? { resetsAt: epochMs(window.reset_at) } : {}),
    };
  }
  if (Object.keys(windows).length === 0) return undefined;
  return { plan: "codex", source: "codex.rate_limits event", windows };
}

export const usageDir = (home: string): string => join(home, "usage");
const planFile = (home: string, plan: string): string => join(usageDir(home), `${plan}.json`);

/** The stored snapshot of a plan, or undefined when none was written yet. */
export async function readPlan(home: string, plan: string): Promise<PlanSnapshot | undefined> {
  const path = planFile(home, plan);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  return parse(PlanSnapshot, value, path);
}

/** Every stored plan snapshot, by file name order. */
export async function readPlans(home: string): Promise<PlanSnapshot[]> {
  let names: string[];
  try {
    names = await readdir(usageDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const plans = names
    .filter((name) => /^[a-z0-9-]+\.json$/.test(name))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  const snapshots = await Promise.all(plans.map((plan) => readPlan(home, plan)));
  return snapshots.filter((snapshot): snapshot is PlanSnapshot => snapshot !== undefined);
}

/** Merges a reading into the plan's file: new windows replace old ones, windows it did not report stay. */
export async function writeReading(
  home: string,
  reading: PlanReading,
  now: number,
): Promise<PlanSnapshot> {
  const previous = await readPlan(home, reading.plan).catch(() => undefined);
  const windows: PlanSnapshot["windows"] = { ...previous?.windows };
  for (const [name, window] of Object.entries(reading.windows)) {
    windows[name] = { ...window, seenAt: now };
  }
  const status = reading.status ?? previous?.status;
  const snapshot: PlanSnapshot = {
    plan: reading.plan,
    ...(status === undefined ? {} : { status }),
    source: reading.source,
    seenAt: now,
    windows,
  };
  await mkdir(usageDir(home), { recursive: true });
  const path = planFile(home, reading.plan);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temp, path);
  return snapshot;
}

export interface WindowView {
  name: string;
  utilization: number;
  resetsAt?: number;
  seenAt: number;
  /** Why the number is not used for routing, if it is not (R18.5). */
  stale?: string;
}

/**
 * A window is stale when its reset time has passed since it was seen (the window started over) or when it was seen
 * longer ago than `maxAgeMs`.
 */
export function windowViews(
  snapshot: PlanSnapshot | undefined,
  now: number,
  maxAgeMs: number,
): WindowView[] {
  return Object.entries(snapshot?.windows ?? {}).map(([name, window]) => {
    let stale: string | undefined;
    if (window.resetsAt !== undefined && window.resetsAt <= now) stale = "reset since it was seen";
    else if (now - window.seenAt > maxAgeMs)
      stale = `seen ${Math.round((now - window.seenAt) / 60_000)} min ago`;
    return { name, ...window, ...(stale ? { stale } : {}) };
  });
}

export interface PlanState {
  plan: string;
  /** `unknown` when no fresh window exists. */
  room: "room" | "full" | "unknown";
  /** Usage pressure on this plan (R4.10). */
  pressure: boolean;
  /** Earliest reset of a full window, epoch ms. */
  resetsAt?: number;
  /** One line per fresh or stale window, for the decision record. */
  notes: string[];
}

/** How a plan stands for routing: only fresh windows count (R18.5). */
export function planState(
  plan: string,
  snapshot: PlanSnapshot | undefined,
  now: number,
  options: { maxAgeMs: number; weekly: number; fiveHour: number },
): PlanState {
  const views = windowViews(snapshot, now, options.maxAgeMs);
  const fresh = views.filter((view) => !view.stale);
  const full = fresh.filter((view) => view.utilization >= 1);
  const weekly = fresh.find((view) => view.name === "7d");
  const fiveHour = fresh.find((view) => view.name === "5h");
  const pressure =
    (weekly !== undefined && weekly.utilization > options.weekly) ||
    (fiveHour !== undefined && fiveHour.utilization >= options.fiveHour);
  const resets = full.map((view) => view.resetsAt).filter((at): at is number => at !== undefined);
  return {
    plan,
    room: fresh.length === 0 ? "unknown" : full.length > 0 ? "full" : "room",
    pressure,
    ...(resets.length > 0 ? { resetsAt: Math.min(...resets) } : {}),
    notes:
      views.length === 0
        ? [`${plan}: no usage seen`]
        : views.map(
            (view) =>
              `${plan} ${view.name} ${Math.round(view.utilization * 100)}%${view.stale ? ` (stale: ${view.stale})` : ""}`,
          ),
  };
}
