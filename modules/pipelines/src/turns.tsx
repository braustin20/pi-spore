import type { PipelineRun, PipelineTurn, StageReport, TestProof } from "@pi-spore/shared";
import type { Tone } from "@pi-spore/ui";

type Finding = NonNullable<StageReport["findings"]>[number];
type Severity = Finding["severity"];

export const SEVERITIES: readonly { severity: Severity; title: string; tone: Tone }[] = [
  { severity: "blocking", title: "Blocking", tone: "fail" },
  { severity: "important", title: "Important", tone: "warn" },
  { severity: "minor", title: "Minor", tone: "neutral" },
];

/** The findings of one severity, one line each. */
export function FindingItems({ findings }: { findings: readonly Finding[] }) {
  return (
    <ul className="mt-1 flex list-none flex-col gap-1 p-0">
      {findings.map((finding, index) => (
        // A report can repeat a title, so the position is part of the key.
        // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed once reported
        <li key={`${finding.title}-${index}`} className="text-sm">
          <span className="font-medium">{finding.title}</span>
          {finding.file && (
            <code className="ml-1.5 text-xs text-muted">
              {finding.file}
              {finding.line ? `:${finding.line}` : ""}
            </code>
          )}
          {finding.detail && (
            <p className="m-0 whitespace-pre-wrap text-xs text-muted">{finding.detail}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The tests a worker added, each with the artifact path that proves it failed first. */
export function TestList({ tests }: { tests: readonly TestProof[] }) {
  return (
    <ul className="mt-1.5 flex list-none flex-col gap-0.5 p-0 text-xs">
      {tests.map((test) => (
        <li key={test.name}>
          <span className="font-medium">{test.name}</span>{" "}
          <span className="text-muted">proof </span>
          <code>{test.proof}</code>
        </li>
      ))}
    </ul>
  );
}

export function routeText(routing: NonNullable<PipelineTurn["routing"]>): string {
  return `Route: ${routing.route}${routing.model ? ` → ${routing.model}` : ""}. ${routing.reasons.join(". ")}`;
}

/** Jev's answer on stopping early. */
export function EarlyStopLine({ earlyStop }: { earlyStop: NonNullable<StageReport["earlyStop"]> }) {
  return (
    <p className="m-0 mt-1.5 text-xs text-muted">
      Jev: {earlyStop.stop ? "stop after this fix" : "keep reviewing"}
      {earlyStop.probability === undefined ? "" : ` (${Math.round(earlyStop.probability * 100)}%)`}
      {earlyStop.error ? `. ${earlyStop.error}` : ""}
    </p>
  );
}

/** The findings of the latest review that reported, counted by severity. */
export function openFindings(run: PipelineRun): Record<Severity, number> | undefined {
  const review = run.turns.findLast((turn) => turn.kind === "review" && turn.report);
  if (!review?.report) return undefined;
  const counts = { blocking: 0, important: 0, minor: 0 };
  for (const finding of review.report.findings ?? []) counts[finding.severity]++;
  return counts;
}
