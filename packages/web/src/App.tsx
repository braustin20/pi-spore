import { HealthResponse, parse } from "@pi-spore/shared";
import { useEffect, useState } from "react";

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: HealthResponse }
  | { kind: "error"; message: string };

export function App({ modules }: { modules: readonly string[] }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Server answered ${response.status}`);
        return parse(HealthResponse, await response.json(), "health response");
      })
      .then((health) => setState({ kind: "ok", health }))
      .catch((error: unknown) => setState({ kind: "error", message: String(error) }));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>pi-spore</h1>
      <p>Placeholder page. Features arrive as modules.</p>
      {state.kind === "loading" && <p>Checking the server...</p>}
      {state.kind === "error" && <p>Server not reachable: {state.message}</p>}
      {state.kind === "ok" && (
        <p>
          Server ok, version {state.health.version}, server modules:{" "}
          {state.health.modules.join(", ") || "none"}.
        </p>
      )}
      <p>Web modules: {modules.join(", ") || "none"}.</p>
    </main>
  );
}
