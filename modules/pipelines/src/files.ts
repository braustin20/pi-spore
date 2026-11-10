import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "@pi-spore/module-api";
import {
  PipelineFile,
  type PipelineSource,
  type PipelineStage,
  parse,
  ValidationError,
} from "@pi-spore/shared";
import { parse as parseToml } from "smol-toml";

/** Used when no user or project file has the id `default`. It goes through the same parser, so it has a hash too. */
export const BUILT_IN_DEFAULT = `id = "default"

[[stage]]
name = "implement"
role = "worker"
tier = "route"

[[stage]]
name = "review"
role = "reviewer"
rounds = 2
fix_passes = 1
early_stop = "jev"
min_strength_over = "implement"

[[stage]]
name = "adversarial"
role = "adversarial-reviewer"
rounds = 1
fix_passes = 1

[[stage]]
name = "gates"
gates = ["check", "test"]
fail_first = "artifact"
`;

/** Used when no user or project file has the id `light`: `default` without the adversarial stage, for small slices. */
export const BUILT_IN_LIGHT = `id = "light"

[[stage]]
name = "implement"
role = "worker"
tier = "route"

[[stage]]
name = "review"
role = "reviewer"
rounds = 2
fix_passes = 1
early_stop = "jev"
min_strength_over = "implement"

[[stage]]
name = "gates"
gates = ["check", "test"]
fail_first = "artifact"
`;

/** Used when no user or project file has the id `revise`: a short fix pass by the worker of an earlier run. */
export const BUILT_IN_REVISE = `id = "revise"

[[stage]]
name = "fix"
role = "worker"
worker = "reuse"

[[stage]]
name = "review"
role = "reviewer"
rounds = 1
fix_passes = 1
min_strength_over = "fix"

[[stage]]
name = "gates"
gates = ["check", "test"]
fail_first = "artifact"
`;

const BUILT_INS = [
  { id: "default", text: BUILT_IN_DEFAULT },
  { id: "light", text: BUILT_IN_LIGHT },
  { id: "revise", text: BUILT_IN_REVISE },
];

/** A pipeline file that passed every check. */
export interface Pipeline {
  id: string;
  source: PipelineSource;
  path?: string;
  hash: string;
  stages: PipelineStage[];
}

export interface FailedPipeline {
  id: string;
  source: PipelineSource;
  path: string;
  error: string;
}

export type PipelineEntry = Pipeline | FailedPipeline;

const TOP_KEYS = ["id", "stage"];
const AGENT_KEYS = ["name", "role", "model", "tier"];
const WORKER_KEYS = [...AGENT_KEYS, "worker"];
const REVIEWER_KEYS = [...AGENT_KEYS, "rounds", "fix_passes", "early_stop", "min_strength_over"];
const GATE_KEYS = ["name", "gates", "fail_first"];
const ALL_STAGE_KEYS = new Set([...WORKER_KEYS, ...REVIEWER_KEYS, ...GATE_KEYS]);

/** The model `tier = "route"` stands for (R4.9). */
export const ROUTE_MODEL = "spore/auto";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads one pipeline file and checks it (R6.2). `name` is the file name without `.toml`, which the file's `id` must
 * equal. `label` is the path shown in errors. Any problem throws a 422 `bad_pipeline` that names the file.
 */
export function parsePipeline(
  bytes: Buffer,
  name: string,
  source: PipelineSource,
  label: string,
): Pipeline {
  const bad = (reason: string) => new ApiError(422, "bad_pipeline", `${label}: ${reason}`);
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(bytes.toString("utf8"));
  } catch (error) {
    throw bad(`not valid TOML: ${(error as Error).message}`);
  }
  // TypeBox names no key for an extra property, so unknown keys are found here first.
  for (const key of Object.keys(raw))
    if (!TOP_KEYS.includes(key)) throw bad(`unknown key "${key}"`);
  if (Array.isArray(raw.stage)) {
    for (const stage of raw.stage) {
      if (!isRecord(stage)) continue;
      for (const key of Object.keys(stage)) {
        if (!ALL_STAGE_KEYS.has(key))
          throw bad(`stage ${JSON.stringify(stage.name ?? "?")} has unknown key "${key}"`);
      }
    }
  }
  let file: PipelineFile;
  try {
    file = parse(PipelineFile, raw, label);
  } catch (error) {
    if (error instanceof ValidationError) throw new ApiError(422, "bad_pipeline", error.message);
    throw error;
  }
  if (file.id !== name) throw bad(`id "${file.id}" must equal the file name "${name}"`);
  checkStages(file.stage, name, source, bad);
  return {
    id: file.id,
    source,
    ...(source === "built-in" ? {} : { path: label }),
    hash: createHash("sha256").update(bytes).digest("hex"),
    stages: file.stage,
  };
}

function checkStages(
  stages: readonly PipelineStage[],
  name: string,
  source: PipelineSource,
  bad: (reason: string) => ApiError,
): void {
  const seen = new Set<string>();
  stages.forEach((stage, index) => {
    const where = `stage "${stage.name}"`;
    if (seen.has(stage.name)) throw bad(`${where}: the name is used twice`);
    seen.add(stage.name);
    // R17.3: a file in the repository never chooses models.
    if (stage.model !== undefined && source === "project") {
      throw bad(
        `${where}: model is not allowed in project pipeline files (R17.3); set it in ~/.pi-spore/pipelines/${name}.toml`,
      );
    }
    if (stage.gates !== undefined && stage.role !== undefined)
      throw bad(`${where}: a stage is an agent stage or a gate stage, never both`);
    if (stage.gates === undefined && stage.role === undefined)
      throw bad(`${where}: needs a role or gates`);
    const kind = stage.gates !== undefined ? "gate" : (stage.role as string);
    const allowed = kind === "gate" ? GATE_KEYS : kind === "worker" ? WORKER_KEYS : REVIEWER_KEYS;
    for (const key of Object.keys(stage)) {
      if (!allowed.includes(key))
        throw bad(`${where}: key "${key}" is not allowed on a ${kind} stage`);
    }
    if (stage.model !== undefined && stage.tier !== undefined)
      throw bad(`${where}: set model or tier, not both`);
    if (stage.worker === "reuse" && (stage.model !== undefined || stage.tier !== undefined))
      throw bad(
        `${where}: worker = "reuse" keeps the earlier worker and its model; remove model and tier`,
      );
    if (stage.tier !== undefined && stage.tier !== "route")
      throw bad(`${where}: tier ${stage.tier} is not built; use route or model`);
    if (stage.role === "worker" && index !== 0)
      throw bad(`${where}: only the first stage may be the worker stage`);
    if (stage.min_strength_over !== undefined) {
      const earlier = stages
        .slice(0, index)
        .find((other) => other.name === stage.min_strength_over);
      if (earlier?.role !== "worker")
        throw bad(`${where}: min_strength_over must name an earlier worker stage`);
    }
  });
  if (stages[0]?.role !== "worker") throw bad("the first stage must be the worker stage");
}

const noFolder = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function readFolder(dir: string, source: PipelineSource): Promise<PipelineEntry[]> {
  const names = await readdir(dir).catch((error) => {
    if (noFolder(error)) return [];
    throw error;
  });
  const entries: PipelineEntry[] = [];
  for (const file of names.filter((entry) => entry.endsWith(".toml")).sort()) {
    const path = join(dir, file);
    const id = file.slice(0, -".toml".length);
    try {
      entries.push(parsePipeline(await readFile(path), id, source, path));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      entries.push({ id, source, path, error: error.message });
    }
  }
  return entries;
}

/**
 * Every pipeline a workspace can start, by id. A project file wins over a user file with the same id (R6.2). A bad
 * file stays in the list with its error, and does not fall back to the built-in one.
 */
export async function loadPipelines(userDir: string, projectDir: string): Promise<PipelineEntry[]> {
  const byId = new Map<string, PipelineEntry>();
  for (const entry of await readFolder(userDir, "user")) byId.set(entry.id, entry);
  for (const entry of await readFolder(projectDir, "project")) byId.set(entry.id, entry);
  for (const { id, text } of BUILT_INS) {
    if (!byId.has(id))
      byId.set(id, parsePipeline(Buffer.from(text), id, "built-in", `built-in ${id}`));
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
