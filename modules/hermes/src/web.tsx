import { SettingsPageKey } from "@pi-spore/mod-projects/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import { HermesStatus, parse } from "@pi-spore/shared";
import { Button, Chip, Notice, Panel, PanelHeader, type Tone } from "@pi-spore/ui";
import { MessagesSquare } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createStatusStore, HermesPage } from "./chat-page.js";
import { HermesPanel } from "./handoffs-page.js";

const TONE: Record<HermesStatus["state"], Tone> = {
  disabled: "neutral",
  unreachable: "warn",
  unauthorized: "fail",
  incompatible: "fail",
  ready: "ok",
};

/** One row on the Settings page with the connector's status (ADR 0202). The key never reaches the browser. */
export function HermesSection() {
  const api = useApi();
  const [status, setStatus] = useState<HermesStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const show = useCallback((answer: Promise<unknown>) => {
    setError(undefined);
    answer
      .then((body) => setStatus(parse(HermesStatus, body, "Hermes status")))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, []);
  useEffect(() => show(api.get("hermes/status")), [api, show]);

  return (
    <Panel>
      <PanelHeader title="Hermes" />
      <div className="flex flex-col gap-2">
        {error && <Notice tone="fail">{error}</Notice>}
        {!status && !error && <p className="m-0 text-muted">Loading...</p>}
        {status && (
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={TONE[status.state]}>{status.state}</Chip>
            <span className="min-w-0 flex-1 text-sm break-words">
              {status.state === "disabled" && "Off. Set hermes.enabled to true to connect."}
              {status.state === "ready" &&
                `Hermes ${status.version} at ${status.url}, profile ${status.profile}.`}
              {"detail" in status && status.detail}
            </span>
            <Button size="sm" onClick={() => show(api.send("POST", "hermes/refresh"))}>
              Reload
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

export const hermesWeb: WebModule = {
  id: "hermes",
  requires: ["projects", "workspaces"],
  core: false,
  setup(host) {
    host.use(SettingsPageKey).addSection({ id: "hermes", order: 20, component: HermesSection });
    const store = createStatusStore(host.api);
    const component = ({ params }: { params: Readonly<Record<string, string>> }) => (
      <HermesPage store={store} params={params} />
    );
    // The rail entry shows only while Hermes is on (ADR 0202 decision 12); Home items link to the page either way.
    host.addPage({
      path: "/hermes",
      title: "Hermes",
      component,
      rail: {
        order: 60,
        icon: MessagesSquare,
        useVisible: () => {
          const status = useSyncExternalStore(store.subscribe, store.get);
          return status !== undefined && status.state !== "disabled";
        },
      },
    });
    host.addPage({ path: "/hermes/:sessionId", title: "Hermes", component });
    host.use(WorkspaceViewKey).addPanel({ id: "hermes", order: 8, component: HermesPanel });
  },
};
