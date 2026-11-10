import { GATE_LOG_HEADING } from "@pi-spore/shared";
import { Notice } from "@pi-spore/ui";
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

/** A run's message. A gate failure carries its log after GATE_LOG_HEADING; the log goes in a closed block. */
export function RunMessage({ message, failed }: { message: string; failed: boolean }) {
  const lines = message.split("\n");
  const at = lines.indexOf(GATE_LOG_HEADING);
  const notice = at < 0 ? message : lines.slice(0, at).join("\n").trim();
  return (
    <>
      <Notice tone={failed ? "fail" : "info"}>
        <span className="whitespace-pre-wrap">{notice}</span>
      </Notice>
      {at >= 0 && <GateLog text={lines.slice(at + 1).join("\n")} />}
    </>
  );
}
