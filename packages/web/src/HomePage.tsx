import { useApi } from "@pi-spore/module-api";
import { HealthResponse, parse } from "@pi-spore/shared";
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
    <section>
      <h1>Home</h1>
      {state.kind === "loading" && <p>Checking the server...</p>}
      {state.kind === "error" && <p className="error">Server not reachable: {state.message}</p>}
      {state.kind === "ok" && (
        <p>
          Server ok, version {state.health.version}. Modules:{" "}
          {state.health.modules.join(", ") || "none"}.
        </p>
      )}
    </section>
  );
}
