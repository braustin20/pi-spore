import { useApi } from "@pi-spore/module-api";
import { HealthResponse, parse } from "@pi-spore/shared";
import { Chip, Notice, Page, PageHeader, Panel, PanelHeader, StatusLine } from "@pi-spore/ui";
import { useEffect, useState } from "react";

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: HealthResponse }
  | { kind: "error"; message: string };

/** The Home page until the attention module replaces it. */
export function HomePage() {
  const api = useApi();
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    api
      .get("health")
      .then((body) =>
        setState({ kind: "ok", health: parse(HealthResponse, body, "health response") }),
      )
      .catch((error: unknown) => setState({ kind: "error", message: String(error) }));
  }, [api]);
  return (
    <Page>
      <PageHeader title="Home" />
      {state.kind === "error" && <Notice tone="fail">Server not reachable: {state.message}</Notice>}
      <Panel>
        <PanelHeader title="Server" />
        {state.kind === "loading" && <StatusLine>Checking the server...</StatusLine>}
        {state.kind === "ok" && (
          <div className="flex flex-col gap-3">
            <StatusLine tone="ok">Server ok, version {state.health.version}</StatusLine>
            <div className="flex flex-wrap gap-1.5">
              {state.health.modules.length === 0 && <span className="text-muted">No modules.</span>}
              {state.health.modules.map((module) => (
                <Chip key={module} mono>
                  {module}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </Page>
  );
}
