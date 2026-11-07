import { useApi } from "@pi-spore/module-api";
import { type ChildRun, type ChildRunState, ChildTranscript, parse } from "@pi-spore/shared";
import { Button, Chip, type Tone } from "@pi-spore/ui";
import { useEffect, useState } from "react";
import Type from "typebox";

const TONE: Record<ChildRunState, Tone> = {
  queued: "neutral",
  running: "run",
  complete: "ok",
  failed: "fail",
  partial: "warn",
  paused: "warn",
  stopped: "neutral",
  rejected: "fail",
};

const TranscriptBody = Type.Object({ transcript: ChildTranscript });

const seconds = (run: ChildRun, now: number) => {
  if (run.startedAt === undefined) return undefined;
  return Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1_000));
};

/** What a helper's agent did. Fetched when opened, because the agent's process answers it. */
function Transcript({ agentId, run }: { agentId: string; run: ChildRun }) {
  const api = useApi();
  const [state, setState] = useState<ChildTranscript | string | undefined>();
  useEffect(() => {
    let current = true;
    api
      .get(`agents/${agentId}/children/${encodeURIComponent(run.id)}/transcript`)
      .then((body) => current && setState(parse(TranscriptBody, body, "transcript").transcript))
      .catch((caught: unknown) => {
        if (current) setState(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      current = false;
    };
  }, [api, agentId, run.id]);

  if (state === undefined) return <p className="m-0 text-muted">Reading…</p>;
  if (typeof state === "string") return <p className="m-0 text-fail">{state}</p>;
  return (
    <div className="flex flex-col gap-2">
      {state.task && <pre className="m-0 whitespace-pre-wrap text-muted">{state.task}</pre>}
      {state.messages.map((message, index) => (
        // The messages are a fixed window of one reply, never reordered.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <pre key={index} className="m-0 whitespace-pre-wrap">
          <span className="text-muted">
            {message.role}
            {message.name ? ` ${message.name}` : ""}:{" "}
          </span>
          {message.text}
        </pre>
      ))}
      {state.finalOutput && <pre className="m-0 whitespace-pre-wrap">{state.finalOutput}</pre>}
      {state.truncated && <p className="m-0 text-muted">pi-subagents cut this short.</p>}
    </div>
  );
}

function Row({ agentId, run, now }: { agentId: string; run: ChildRun; now: number }) {
  const [open, setOpen] = useState(false);
  const elapsed = seconds(run, now);
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-line bg-raised px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={TONE[run.state]}>{run.state}</Chip>
        <span className="font-medium">{run.label}</span>
        {run.currentTool && <Chip mono>{run.currentTool}</Chip>}
        {elapsed !== undefined && <span className="font-mono text-xs text-muted">{elapsed}s</span>}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide transcript" : "Transcript"}
        </Button>
      </div>
      {run.steps.map((step) => (
        <div key={step.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{step.agent ?? step.label}</span>
          {step.model && <span className="font-mono">{step.model}</span>}
          {step.thinking && <span>{step.thinking}</span>}
          {run.steps.length > 1 && <Chip tone={TONE[step.state]}>{step.state}</Chip>}
        </div>
      ))}
      {open && <Transcript agentId={agentId} run={run} />}
    </li>
  );
}

/** The worker's background pi-subagents helpers: which agent, which model, and the state (R3.3, ADR 0034). */
export function Helpers({ agentId, runs }: { agentId: string; runs: readonly ChildRun[] }) {
  const [now, setNow] = useState(() => Date.now());
  const running = runs.some((run) => run.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  if (runs.length === 0) return null;
  return (
    <section aria-label="Helpers" className="flex flex-col gap-1.5">
      <h2 className="m-0 text-xs font-semibold tracking-wider text-muted uppercase">Helpers</h2>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {runs.map((run) => (
          <Row key={run.id} agentId={agentId} run={run} now={now} />
        ))}
      </ul>
    </section>
  );
}
