import { useApi } from "@pi-spore/module-api";
import {
  MODEL_TIERS,
  ModelChoices,
  parse,
  type RoleModel,
  RoleModelsResponse,
  type SetRoleModelRequest,
} from "@pi-spore/shared";
import { Button, ModelPicker, Notice, Panel, PanelHeader } from "@pi-spore/ui";
import { useEffect, useRef, useState } from "react";

const errorText = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

const GROUPS = [
  { kind: "role", title: "pi-spore agents" },
  { kind: "subagent", title: "Subagents" },
] as const;

/** The default model of each role and subagent, saved at once on pick (ADR 0181). */
export function RoleModelsSection() {
  const api = useApi();
  const [roles, setRoles] = useState<RoleModel[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [choices, setChoices] = useState<ModelChoices>({ models: [] });
  const [modelsError, setModelsError] = useState<string | undefined>();

  useEffect(() => {
    api
      .get("agents/role-models")
      .then((body) => setRoles(parse(RoleModelsResponse, body, "role models").roles))
      .catch((caught: unknown) => setError(errorText(caught)));
    api
      .get("agents/models")
      .then((body) => setChoices(parse(ModelChoices, body, "models")))
      .catch((caught: unknown) => setModelsError(errorText(caught)));
  }, [api]);

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The PUT answers the whole new list, so a save needs no second load. The server may finish two writes in either
  // order, so one save waits for the answer of the one before: the last answer then holds every change.
  const save = (name: string, body: SetRoleModelRequest) => {
    const run = queue.current
      .then(() => api.send("PUT", `agents/role-models/${encodeURIComponent(name)}`, body))
      .then((answer) => setRoles(parse(RoleModelsResponse, answer, "role models").roles));
    queue.current = run.catch(() => undefined);
    return run;
  };

  return (
    <Panel>
      <PanelHeader title="Role models" />
      <div className="flex flex-col gap-3">
        {error && <Notice tone="fail">{error}</Notice>}
        {modelsError && <Notice tone="warn">Could not load the model list: {modelsError}.</Notice>}
        {!roles && !error && <p className="text-muted">Loading...</p>}
        {roles &&
          GROUPS.map(({ kind, title }) => (
            <section key={kind} aria-label={title} className="flex flex-col gap-2">
              <h3 className="m-0 text-sm font-semibold">{title}</h3>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {roles
                  .filter((role) => role.kind === kind)
                  .map((role) => (
                    <RoleRow key={role.name} role={role} choices={choices} save={save} />
                  ))}
              </ul>
            </section>
          ))}
        <p className="m-0 text-sm text-muted">
          Saves to <code>~/.pi/agent/settings.json</code> (<code>subagents.agentOverrides</code>).
          The next agent of that role starts on it.
        </p>
      </div>
    </Panel>
  );
}

function RoleRow({
  role,
  choices,
  save,
}: {
  role: RoleModel;
  choices: ModelChoices;
  save: (name: string, body: SetRoleModelRequest) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const value = role.model ?? "";
  const defaultLabel = role.fallback === "orchestrator" ? "Same as orchestrator" : "Pi default";
  const listed = choices.models.find((model) => `${model.provider}/${model.id}` === value);
  const label = value === "" ? defaultLabel : (listed?.name ?? value);

  const run = (body: SetRoleModelRequest) => {
    setError(undefined);
    setBusy(true);
    save(role.name, body)
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row md:items-start">
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <code>{role.name}</code>
          {role.description && <p className="m-0 text-sm text-muted">{role.description}</p>}
        </div>
        <ModelPicker
          value={value}
          label={label}
          models={choices.models}
          tiers={MODEL_TIERS}
          onChange={(model) => run(model === "" ? { unset: true } : { model })}
          defaultLabel={defaultLabel}
          tierError={choices.tierError}
          disabled={busy}
          // A raw model id can be long with no spaces; the trigger grows and wraps it rather than cutting it off.
          className="h-auto min-h-8 w-full py-1 md:w-72 md:shrink-0 [&>span]:whitespace-normal [&>span]:[overflow-wrap:anywhere]"
          aria-label={`Model for ${role.name}`}
        />
        <Button disabled={busy || role.model === undefined} onClick={() => run({ unset: true })}>
          Reset
        </Button>
      </div>
      {error && <Notice tone="fail">{error}</Notice>}
    </li>
  );
}
