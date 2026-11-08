import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { usageDir } from "./usage.js";

const Probability = Type.Number({ minimum: 0, maximum: 1 });

/** One routing decision (R4.7), one JSON line in `<home>/usage/routing.jsonl`. */
export const RoutingRecord = Type.Object({
  at: Type.Number(),
  /** `initial` on a session's first request, `escalation` when a local session moves to the cloud, `error` when the
   * router itself failed and sent the request to the cloud model. */
  kind: Type.Union([Type.Literal("initial"), Type.Literal("escalation"), Type.Literal("error")]),
  route: Type.Union([
    Type.Literal("local"),
    Type.Literal("cloud"),
    Type.Literal("spill"),
    Type.Literal("wait"),
  ]),
  /** `provider/id`. Absent for `wait`. */
  model: Type.Optional(Type.String()),
  reasons: Type.Array(Type.String()),
  sessionId: Type.Optional(Type.String()),
  sessionFile: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  /** Set when the session runs as a pi-spore agent. */
  agentId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
  estimate: Type.Optional(Type.Number()),
  budget: Type.Optional(Type.Number()),
  jev: Type.Optional(
    Type.Union([
      Type.Object({
        bounded: Probability,
        explicit: Probability,
        visual: Probability,
        straightforward: Probability,
      }),
      Type.Object({ error: Type.String() }),
    ]),
  ),
  threshold: Type.Optional(Type.Number()),
  pressure: Type.Optional(Type.Boolean()),
  /** Set when the task went local only because of the `router.explore` draw (ADR 0144). */
  explore: Type.Optional(Type.Boolean()),
  /** The plan windows the decision saw, one line each. */
  usage: Type.Optional(Type.Array(Type.String())),
  resetsAt: Type.Optional(Type.Number()),
});

export type RoutingRecord = Static<typeof RoutingRecord>;

export const routingFile = (home: string): string => join(usageDir(home), "routing.jsonl");

export async function appendRecord(home: string, record: RoutingRecord): Promise<void> {
  await mkdir(usageDir(home), { recursive: true });
  await appendFile(routingFile(home), `${JSON.stringify(record)}\n`);
}

/**
 * The newest `limit` records, newest first. Lines that do not parse or do not match the schema are counted in
 * `skipped`: a crash can leave a partial last line, and older versions may have written other fields.
 */
export async function readRecords(
  home: string,
  limit: number,
): Promise<{ records: RoutingRecord[]; skipped: number }> {
  let text: string;
  try {
    text = await readFile(routingFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    throw error;
  }
  const records: RoutingRecord[] = [];
  let skipped = 0;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (const line of lines.reverse()) {
    if (records.length >= limit) break;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (Check(RoutingRecord, value)) records.push(value);
    else skipped++;
  }
  return { records, skipped };
}

/**
 * Removes the lines whose `at` is before `before` and returns how many went (ADR 0121). A line that does not parse
 * or has no numeric `at` stays: it is not ours to judge. Nothing is rewritten when nothing is old.
 */
export async function pruneRecords(home: string, before: number): Promise<number> {
  const file = routingFile(home);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const lines = bytes.toString("utf8").split("\n");
  const kept = lines.filter((line) => {
    try {
      const at = (JSON.parse(line) as { at?: unknown } | null)?.at;
      return typeof at !== "number" || at >= before;
    } catch {
      return true;
    }
  });
  const removed = lines.length - kept.length;
  if (removed === 0) return 0;
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, kept.join("\n"));
    // The router appends from other Pi processes: carry over what came after the read.
    const grown = (await stat(file)).size - bytes.length;
    if (grown > 0) {
      const source = await open(file, "r");
      try {
        const extra = Buffer.alloc(grown);
        await source.read(extra, 0, grown, bytes.length);
        await appendFile(temp, extra);
      } finally {
        await source.close();
      }
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return removed;
}
