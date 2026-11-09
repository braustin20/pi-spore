import type { PipelineRun, PipelineTurn, StageReport } from "@pi-spore/shared";
import { Chip, type Tone } from "@pi-spore/ui";

type Severity = NonNullable<StageReport["findings"]>[number]["severity"];

export const SEVERITIES: readonly { severity: Severity; title: string; tone: Tone }[] = [
  { severity: "blocking", title: "Blocking", tone: "fail" },
  { severity: "important", title: "Important", tone: "warn" },
  { severity: "minor", title: "Minor", tone: "neutral" },
];

const KIND_TITLES: Record<PipelineTurn["kind"], string> = {
  task: "Task",
  fix: "Fix",
  review: "Review",
};

function Findings({ report }: { report: StageReport }) {
  return (
    <>
      {SEVERITIES.map(({ severity, title, tone }) => {
        const found = (report.findings ?? []).filter((finding) => finding.severity === severity);
        if (found.length === 0) return null;
        return (
          <div key={severity} className="mt-1.5">
            <Chip tone={tone}>
              {title} · {found.length}
            </Chip>
            <ul className="mt-1 flex list-none flex-col gap-1 p-0">
              {found.map((finding, index) => (
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
          </div>
        );
      })}
    </>
  );
}

function Report({ report, routing }: { report: StageReport; routing: PipelineTurn["routing"] }) {
  const { earlyStop } = report;
  return (
    <div className="mt-1.5 flex flex-col text-sm">
      <p className="m-0 whitespace-pre-wrap">{report.summary}</p>
      <Findings report={report} />
      {report.tests && report.tests.length > 0 && (
        <ul className="mt-1.5 flex list-none flex-col gap-0.5 p-0 text-xs">
          {report.tests.map((test) => (
            <li key={test.name}>
              <span className="font-medium">{test.name}</span>{" "}
              <span className="text-muted">proof </span>
              <code>{test.proof}</code>
            </li>
          ))}
        </ul>
      )}
      {routing && (
        <p className="m-0 mt-1.5 text-xs text-muted">
          Route: {routing.route}
          {routing.model ? ` → ${routing.model}` : ""}. {routing.reasons.join(". ")}
        </p>
      )}
      {earlyStop && (
        <p className="m-0 mt-1.5 text-xs text-muted">
          Jev: {earlyStop.stop ? "stop after this fix" : "keep reviewing"}
          {earlyStop.probability === undefined
            ? ""
            : ` (${Math.round(earlyStop.probability * 100)}%)`}
          {earlyStop.error ? `. ${earlyStop.error}` : ""}
        </p>
      )}
    </div>
  );
}

/** The turns of one stage, in order: what each agent was asked, and what it reported. */
export function TurnList({
  turns,
  workspaceId,
}: {
  turns: readonly PipelineTurn[];
  workspaceId: string;
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {turns.map((turn) => (
        <li key={turn.id} className="border-t border-line py-2 first:border-t-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone="accent">{KIND_TITLES[turn.kind]}</Chip>
            <Chip>round {turn.round}</Chip>
            <Chip mono>{turn.role}</Chip>
            {turn.error && <Chip tone="fail">Failed</Chip>}
            {turn.report?.verdict && (
              <Chip tone={turn.report.verdict === "approve" ? "ok" : "warn"}>
                {turn.report.verdict === "approve" ? "Approve" : "Revise"}
              </Chip>
            )}
            <a
              href={`#/workspaces/${workspaceId}/chats/${turn.agentId}`}
              className="ml-auto text-xs text-accent-strong"
            >
              Open chat
            </a>
          </div>
          {turn.modelNote && (
            <p className="m-0 mt-1.5 whitespace-pre-wrap text-sm text-muted">{turn.modelNote}</p>
          )}
          {turn.report ? (
            <Report report={turn.report} routing={turn.routing} />
          ) : turn.error ? (
            <p className="m-0 mt-1.5 whitespace-pre-wrap text-sm text-muted">{turn.error}</p>
          ) : (
            <p className="m-0 mt-1.5 text-sm text-muted">Waiting for the report.</p>
          )}
        </li>
      ))}
    </ul>
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
