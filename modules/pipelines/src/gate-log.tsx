import { GATE_LOG_HEADING } from "@pi-spore/shared";
import { ChevronRight } from "lucide-react";

/** A failed gate's log tail, folded: the lines can be long and are rarely what you need first. */
export function GateLog({ text }: { text: string }) {
  return (
    <details className="group rounded-lg border border-line bg-panel text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90"
        />
        Log (last 4 KB)
      </summary>
      <pre className="m-0 max-h-80 overflow-auto border-t border-line p-2.5 font-mono text-xs text-fg [overflow-wrap:anywhere] whitespace-pre-wrap">
        {text}
      </pre>
    </details>
  );
}

/** A run's message. A gate failure carries its log after GATE_LOG_HEADING; the rest is the notice. */
export function splitRunMessage(message: string): { notice: string; log?: string } {
  const lines = message.split("\n");
  const at = lines.indexOf(GATE_LOG_HEADING);
  if (at < 0) return { notice: message };
  return { notice: lines.slice(0, at).join("\n").trim(), log: lines.slice(at + 1).join("\n") };
}
