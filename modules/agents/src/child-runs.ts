import { type ChildRun, type ChildTranscript, parse } from "@pi-spore/shared";
import Type from "typebox";

/** The widget keys pi-subagents uses to talk to an RPC host (spike Q5, ADR 0034). */
export const CHILD_RUNS_WIDGET = "subagent-async";
export const INSPECT_WIDGET = "subagent-inspect";

const SNAPSHOT_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const INSPECT_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";
const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
const INSPECT_KIND = "pi-subagents.inspect-reply";
/** The only payload version pi-spore reads. A new one fails loudly instead of being half understood. */
const VERSION = 1;

const State = Type.Union(
  ["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"].map(
    (state) => Type.Literal(state),
  ),
);

// Open objects: pi-subagents may add fields, and the docs tell consumers to ignore them.
const Node = Type.Object({
  id: Type.String(),
  label: Type.String(),
  state: State,
  startedAt: Type.Optional(Type.Integer()),
  endedAt: Type.Optional(Type.Integer()),
  activity: Type.Optional(Type.Object({ currentTool: Type.Optional(Type.String()) })),
  agent: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  children: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
});

const Snapshot = Type.Object({
  kind: Type.Literal(SNAPSHOT_KIND),
  version: Type.Literal(VERSION),
  runs: Type.Array(Type.Object({}, { additionalProperties: true })),
});

/** The JSON of a `PI_*_JSON:` widget payload: one line with the prefix. */
function payload(lines: unknown, prefix: string, what: string): unknown {
  const line = Array.isArray(lines) && lines.length === 1 ? lines[0] : undefined;
  if (typeof line !== "string" || !line.startsWith(prefix)) {
    throw new Error(`The ${what} widget is not one ${prefix} line`);
  }
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    throw new Error(`The ${what} widget does not hold valid JSON`);
  }
}

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const toStep = (raw: unknown): ChildRun["steps"][number] => {
  const node = parse(Node, raw, "pi-subagents step");
  return {
    id: node.id,
    label: node.label,
    state: node.state,
    ...optional("agent", node.agent),
    ...optional("model", node.model),
    ...optional("thinking", node.thinking),
    ...optional("currentTool", node.activity?.currentTool),
    ...optional("startedAt", node.startedAt),
    ...optional("endedAt", node.endedAt),
  };
};

/**
 * The child runs in a `subagent-async` widget's lines. A cleared widget (no lines) means none. Throws a readable
 * error for a payload that is not a version 1 snapshot. Times of last activity are left out on purpose: they change
 * every second and the page does not show them.
 */
export function parseChildRuns(lines: unknown): ChildRun[] {
  if (lines === undefined || lines === null) return [];
  const snapshot = parse(
    Snapshot,
    payload(lines, SNAPSHOT_PREFIX, CHILD_RUNS_WIDGET),
    "pi-subagents status",
  );
  return snapshot.runs.map((raw): ChildRun => {
    const run = parse(Node, raw, "pi-subagents run");
    return {
      id: run.id,
      label: run.label,
      state: run.state,
      ...optional("currentTool", run.activity?.currentTool),
      ...optional("startedAt", run.startedAt),
      ...optional("endedAt", run.endedAt),
      steps: (run.children ?? []).map(toStep),
    };
  });
}

/** Runs that hold a runner process. A queued run has none yet (ADR 0034). */
export const runningCount = (runs: readonly ChildRun[]): number =>
  runs.filter((run) => run.state === "running").length;

const InspectReply = Type.Object({
  kind: Type.Literal(INSPECT_KIND),
  version: Type.Literal(VERSION),
  requestId: Type.String(),
  asyncId: Type.Optional(Type.String()),
  childId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  messages: Type.Optional(
    Type.Array(
      Type.Object({
        role: Type.String(),
        kind: Type.String(),
        text: Type.String(),
        name: Type.Optional(Type.String()),
        isError: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
  finalOutput: Type.Optional(Type.String()),
  resolvedModel: Type.Optional(Type.Object({ provider: Type.String(), model: Type.String() })),
  truncated: Type.Optional(
    Type.Object({
      task: Type.Boolean(),
      messages: Type.Number(),
      finalOutput: Type.Boolean(),
    }),
  ),
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
});

export interface InspectResult {
  requestId: string;
  /** Present when pi-subagents refused or could not read the run. */
  error?: { code: string; message: string };
  transcript?: ChildTranscript;
}

/** One `subagent-inspect` widget reply, correlated by its request id. */
export function parseInspectReply(lines: unknown): InspectResult {
  const reply = parse(
    InspectReply,
    payload(lines, INSPECT_PREFIX, INSPECT_WIDGET),
    "pi-subagents inspect reply",
  );
  if (reply.error) return { requestId: reply.requestId, error: reply.error };
  const truncated = reply.truncated;
  return {
    requestId: reply.requestId,
    transcript: {
      ...optional("childId", reply.childId),
      ...optional("status", reply.status),
      ...optional("label", reply.label),
      ...optional("task", reply.task),
      messages: reply.messages ?? [],
      ...optional("finalOutput", reply.finalOutput),
      ...optional(
        "model",
        reply.resolvedModel && `${reply.resolvedModel.provider}/${reply.resolvedModel.model}`,
      ),
      truncated:
        truncated !== undefined &&
        (truncated.task || truncated.finalOutput || truncated.messages > 0),
    },
  };
}
