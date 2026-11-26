import Type, { type Static, type TSchema } from "typebox";

// SSE frames of `GET /v1/runs/{id}/events` carry `id:` and `data:` only. The event name is `data.event`
// (spike Q4). Each known event names the fields pi-spore reads; others pass through as unknown keys.

const event = <N extends string, P extends Record<string, TSchema>>(name: N, properties: P) =>
  Type.Object({ event: Type.Literal(name), ...properties });

const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));

export const RunEvent = Type.Union([
  event("message.started", {}),
  event("message.delta", { delta: Type.String() }),
  event("message.interim", {}),
  event("reasoning.available", {}),
  event("tool.started", { tool: Type.String(), preview: Text }),
  event("tool.progress", {}),
  event("tool.completed", { tool: Text, error: Type.Optional(Type.Boolean()) }),
  event("tool.failed", { tool: Text }),
  event("approval.request", {}),
  event("approval.responded", {}),
  event("clarify.request", {}),
  event("run.steered", {}),
  event("run.stopping", {}),
  event("run.completed", { output: Text }),
  event("run.cancelled", {}),
  event("run.failed", {}),
  event("run.interrupted", {}),
  // Old frames are gone: events before `oldest_retained_seq` are lost, so read the run status to fill the gap.
  event("replay.truncated", { oldest_retained_seq: Type.Integer() }),
]);
export type RunEvent = Static<typeof RunEvent>;

export const KNOWN_EVENTS: ReadonlySet<string> = new Set(
  RunEvent.anyOf.map((schema) => schema.properties.event.const),
);

/** After one of these the stream ends. */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "run.completed",
  "run.cancelled",
  "run.failed",
  "run.interrupted",
]);

export interface SseFrame {
  id: string | undefined;
  data: string;
}

/**
 * Splits an SSE body into frames. Comment lines (`: keepalive`) and frames without `data:` are dropped. `onChunk` runs
 * for every chunk read, keepalives too, so a caller can tell a quiet stream from a dead one.
 */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        if (line === "") {
          if (data.length > 0) yield { id, data: data.join("\n") };
          id = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? "" : line.slice(colon + 1);
        const text = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "id") id = text;
        else if (field === "data") data.push(text);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
