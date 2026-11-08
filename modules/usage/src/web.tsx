import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  type CalibrationBar,
  CalibrationResponse,
  parse,
  RoutingDecisionsResponse,
  TokenUseResponse,
  type UsagePlan,
  UsagePlansResponse,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  EmptyState,
  Notice,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Table,
  TableCell,
  TableHead,
} from "@pi-spore/ui";
import { Gauge, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatAge, formatShare, formatTokens, formatUntil, windowTitle } from "./format.js";

const PLAN_TITLES: Readonly<Record<string, string>> = { claude: "Claude", codex: "OpenAI Codex" };

interface Data {
  plans: UsagePlansResponse;
  tokens: TokenUseResponse;
  routing: RoutingDecisionsResponse;
  calibration: CalibrationResponse;
  loadedAt: number;
}

function Bar({ value, tone }: { value: number; tone: "accent" | "warn" | "fail" }) {
  const width = `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`;
  const fill = { accent: "bg-accent", warn: "bg-warn", fail: "bg-fail" }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
      <div className={`h-full ${fill}`} style={{ width }} />
    </div>
  );
}

const TooLittleData = () => <span className="text-muted"> too little data</span>;

function BarRow({ bar, calibration }: { bar: CalibrationBar; calibration: CalibrationResponse }) {
  return (
    <tr>
      <TableCell className="font-mono">
        {bar.bar}
        {bar.bar === calibration.threshold && (
          <Chip className="ml-1.5" title="router.threshold now">
            now
          </Chip>
        )}
        {bar.bar === calibration.suggestedBar && (
          <Chip tone="ok" className="ml-1.5">
            suggested
          </Chip>
        )}
      </TableCell>
      <TableCell>{formatShare(bar.wouldGoLocal, bar.decisions)}</TableCell>
      <TableCell>
        {bar.localOutcomes === 0 ? "no outcomes" : formatShare(bar.passed, bar.localOutcomes)}
        {!bar.enough && <TooLittleData />}
      </TableCell>
    </tr>
  );
}

function CalibrationPanel({ calibration }: { calibration: CalibrationResponse }) {
  const questions = Object.entries(calibration.buckets);
  return (
    <Panel>
      <PanelHeader title="Routing calibration" />
      {calibration.decisions === 0 ? (
        <p className="m-0 text-sm text-muted">
          No decisions with Jev answers yet. The report fills in as spore/auto routes tasks.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm">
            {calibration.decisions} decisions with Jev answers, {calibration.outcomes} local
            outcomes. Bar now: {calibration.threshold}.{" "}
            {calibration.suggestedBar === undefined
              ? `No suggested bar: no bar has ${calibration.minSample} local outcomes with 90% passed.`
              : `Suggested bar: ${calibration.suggestedBar}. pi-spore never changes the bar; set router.threshold in settings.json.`}
          </p>
          <Table>
            <thead>
              <tr>
                <TableHead>Bar</TableHead>
                <TableHead>Would go local</TableHead>
                <TableHead>Passed</TableHead>
              </tr>
            </thead>
            <tbody>
              {calibration.bars.map((bar) => (
                <BarRow key={bar.bar} bar={bar} calibration={calibration} />
              ))}
            </tbody>
          </Table>
          <Table>
            <thead>
              <tr>
                <TableHead>Answer</TableHead>
                {questions.map(([question]) => (
                  <TableHead key={question}>{question}</TableHead>
                ))}
              </tr>
            </thead>
            <tbody>
              {calibration.buckets.bounded.map((range, index) => (
                <tr key={range.from}>
                  <TableCell className="font-mono text-xs">
                    {range.from.toFixed(1)}–{range.to.toFixed(1)}
                  </TableCell>
                  {questions.map(([question, buckets]) => {
                    const bucket = buckets[index];
                    return (
                      <TableCell key={question} className="text-xs">
                        {bucket?.answers} answers
                        {bucket && bucket.localOutcomes > 0 && (
                          <>
                            , {bucket.passed}/{bucket.localOutcomes} passed
                            {!bucket.enough && <TooLittleData />}
                          </>
                        )}
                      </TableCell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {calibration.skipped > 0 && (
        <p className="mt-2 mb-0 text-xs text-muted">
          {calibration.skipped} lines of the decision file did not parse.
        </p>
      )}
    </Panel>
  );
}

function PlanPanel({
  plan,
  now,
  thresholds,
}: {
  plan: UsagePlan;
  now: number;
  thresholds: { weekly: number; fiveHour: number };
}) {
  return (
    <Panel>
      <PanelHeader title={PLAN_TITLES[plan.plan] ?? plan.plan}>
        {plan.status && <Chip mono>{plan.status}</Chip>}
        <span className="text-xs text-muted">seen {formatAge(plan.ageMs)}</span>
      </PanelHeader>
      <div className="flex flex-col gap-3">
        {plan.windows.map((window) => {
          const limit = window.name === "7d" ? thresholds.weekly : thresholds.fiveHour;
          const tone =
            window.utilization >= 1 ? "fail" : window.utilization > limit ? "warn" : "accent";
          return (
            <div key={window.name} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {windowTitle(window.name)}{" "}
                  <span className="font-mono">{Math.round(window.utilization * 100)}%</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {window.resetsAt !== undefined && (
                    <span title={new Date(window.resetsAt).toLocaleString()}>
                      resets {formatUntil(window.resetsAt, now)}
                    </span>
                  )}
                  <span>seen {formatAge(window.ageMs)}</span>
                  {window.stale && (
                    <Chip tone="warn" title={`Not used for routing: ${window.stale}`}>
                      stale
                    </Chip>
                  )}
                </span>
              </div>
              <Bar value={window.utilization} tone={window.stale ? "accent" : tone} />
            </div>
          );
        })}
        <p className="m-0 text-xs text-muted">From {plan.source}.</p>
      </div>
    </Panel>
  );
}

function UsagePage() {
  const api = useApi();
  const [data, setData] = useState<Data | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    Promise.all([
      api.get("usage/plans"),
      api.get("usage/tokens"),
      api.get("usage/routing"),
      api.get("usage/calibration"),
    ])
      .then(([plans, tokens, routing, calibration]) => {
        setData({
          plans: parse(UsagePlansResponse, plans, "usage plans"),
          tokens: parse(TokenUseResponse, tokens, "token use"),
          routing: parse(RoutingDecisionsResponse, routing, "routing decisions"),
          calibration: parse(CalibrationResponse, calibration, "routing calibration"),
          loadedAt: Date.now(),
        });
        setError(undefined);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setBusy(false));
  }, [api]);
  useEffect(load, [load]);

  const knownPlans = new Set(data?.plans.plans.map((plan) => plan.plan));
  return (
    <Page>
      <PageHeader title="Usage">
        <Button onClick={load} disabled={busy}>
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </Button>
      </PageHeader>
      {error && <Notice tone="fail">{error}</Notice>}
      {data?.plans.warnings.map((warning) => (
        <Notice
          key={`${warning.plan}-${warning.window}`}
          tone={warning.utilization >= 1 ? "fail" : "warn"}
        >
          {warning.message}
        </Notice>
      ))}
      {data?.plans.errors.map((message) => (
        <Notice key={message} tone="fail">
          {message}
        </Notice>
      ))}
      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {data.plans.plans.map((plan) => (
              <PlanPanel
                key={plan.plan}
                plan={plan}
                now={data.loadedAt}
                thresholds={data.plans.thresholds}
              />
            ))}
            {["claude", "codex"]
              .filter((plan) => !knownPlans.has(plan))
              .map((plan) => (
                <Panel key={plan}>
                  <PanelHeader title={PLAN_TITLES[plan] ?? plan} />
                  <p className="m-0 text-sm text-muted">
                    No numbers seen yet. They appear after a request to this plan from any Pi
                    process that loads the pi-spore router.
                  </p>
                </Panel>
              ))}
          </div>
          <p className="m-0 text-xs text-muted">
            Numbers older than {data.plans.maxAgeMinutes} min, or older than their window's reset,
            are stale and not used for routing.
          </p>

          <Panel>
            <PanelHeader title="Token use by workspace and model" />
            {data.tokens.rows.length === 0 ? (
              <EmptyState icon={Gauge} title="No agent sessions yet">
                Token use appears after an agent in a workspace answers.
              </EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <TableHead>Project</TableHead>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Input</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                    <TableHead className="text-right">Cache read</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {data.tokens.rows.map((row) => (
                    <tr key={`${row.workspaceId}/${row.provider}/${row.model}`}>
                      <TableCell>{row.projectName}</TableCell>
                      <TableCell>
                        <a href={`#/workspaces/${row.workspaceId}`}>{row.workspaceName}</a>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.provider}/{row.model}
                        {row.local && (
                          <Chip tone="ok" className="ml-1.5">
                            local
                          </Chip>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{row.requests}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatTokens(row.input)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatTokens(row.output)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatTokens(row.cacheRead)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.local ? "free" : `$${row.cost.toFixed(2)}`}
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="mt-2 mb-0 text-xs text-muted">
              From {data.tokens.sessions} pi-spore session files. Subscription models show their
              catalog price, which is $0 through claude-bridge.
            </p>
          </Panel>

          <Panel>
            <PanelHeader title="Routing decisions (spore/auto)" />
            {data.routing.decisions.length === 0 ? (
              <p className="m-0 text-sm text-muted">
                No decisions yet. Pick the model spore/auto for an agent to use the router.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <TableHead>When</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Why</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {data.routing.decisions.map((decision) => (
                    <tr key={`${decision.at}-${decision.sessionId ?? ""}-${decision.kind}`}>
                      <TableCell className="whitespace-nowrap text-xs text-muted">
                        {formatAge(data.loadedAt - decision.at)}
                      </TableCell>
                      <TableCell>
                        <Chip
                          tone={
                            decision.route === "local"
                              ? "ok"
                              : decision.route === "wait" || decision.kind === "error"
                                ? "fail"
                                : "neutral"
                          }
                        >
                          {decision.kind === "initial"
                            ? decision.route
                            : `${decision.route} (${decision.kind})`}
                        </Chip>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {decision.model ?? "none"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {decision.reasons.join("; ")}
                        {decision.estimate !== undefined && (
                          <span className="text-muted">
                            {" "}
                            (estimate {formatTokens(decision.estimate)}
                            {decision.budget !== undefined &&
                              ` of ${formatTokens(decision.budget)}`}
                            )
                          </span>
                        )}
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {data.routing.skipped > 0 && (
              <p className="mt-2 mb-0 text-xs text-muted">
                {data.routing.skipped} lines of the decision file did not parse.
              </p>
            )}
          </Panel>

          <CalibrationPanel calibration={data.calibration} />
        </>
      )}
    </Page>
  );
}

export const usageWeb: WebModule = {
  id: "usage",
  requires: [],
  core: false,
  setup(host) {
    host.addPage({
      path: "/usage",
      title: "Usage",
      rail: { order: 40, icon: Gauge },
      component: UsagePage,
    });
  },
};
