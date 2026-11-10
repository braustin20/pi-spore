import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  Project,
  ProjectConfigView,
  ProjectList,
  parse,
  type SaveSettingRequest,
  SettingsView,
  type Workspace,
  WorkspaceList,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  Notice,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Table,
  TableCell,
  TableHead,
  Textarea,
  useConfirm,
} from "@pi-spore/ui";
import { FolderGit2, Settings } from "lucide-react";
import { type ReactNode, type SubmitEvent, useCallback, useEffect, useRef, useState } from "react";
import Type from "typebox";

const ConfigBody = Type.Object({ config: ProjectConfigView, warnings: Type.Array(Type.String()) });
const ProjectBody = Type.Object({ project: Project });

function TraitChips({ project }: { project: Project }) {
  return (
    <span className="flex flex-wrap gap-1">
      {project.traits.map((trait) => (
        <Chip key={trait.id} tone="accent" mono>
          {trait.detail ? `${trait.id} ${trait.detail}` : trait.id}
        </Chip>
      ))}
    </span>
  );
}

function ProjectsPage() {
  const api = useApi();
  const [projects, setProjects] = useState<Project[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .get("projects")
      .then((body) => setProjects(parse(ProjectList, body, "project list").projects))
      .catch((caught: unknown) => setError(String(caught)));
  }, [api]);
  useEffect(load, [load]);

  const add = (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    api
      .send("POST", "projects", {
        path: path.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      .then(() => {
        setPath("");
        setName("");
        load();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Page>
      <PageHeader title="Projects" />
      <Panel>
        <PanelHeader title="Add a project" />
        <form className="flex flex-wrap items-end gap-3" onSubmit={add}>
          <Field
            label="Folder (absolute path)"
            className="min-w-80 flex-1 max-md:min-w-0 max-md:basis-full"
          >
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/home/you/code/game"
              className="font-mono"
            />
          </Field>
          <Field label="Name (optional)">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button variant="primary" type="submit" disabled={busy || path.trim() === ""}>
            Add project
          </Button>
        </form>
      </Panel>
      {error && <Notice tone="fail">{error}</Notice>}
      {projects === undefined && !error && <p className="text-muted">Loading...</p>}
      {projects?.length === 0 && (
        <EmptyState icon={FolderGit2} title="No projects yet">
          Add a Git checkout or a folder above.
        </EmptyState>
      )}
      {projects && projects.length > 0 && (
        <Table>
          <thead>
            <tr>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead>Path</TableHead>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <TableCell>
                  <a href={`#/projects/${project.id}`}>{project.name}</a>
                </TableCell>
                <TableCell>
                  <Chip mono>{project.vcs}</Chip>
                </TableCell>
                <TableCell>
                  {project.traits.length === 0 ? (
                    <span className="text-muted">-</span>
                  ) : (
                    <TraitChips project={project} />
                  )}
                </TableCell>
                <TableCell>
                  <code className="text-muted">{project.path}</code>
                </TableCell>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}

function ProjectPage({ params }: { params: Readonly<Record<string, string>> }) {
  const api = useApi();
  const { confirm, dialog } = useConfirm();
  const id = params.id ?? "";
  const [project, setProject] = useState<Project | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .get(`projects/${id}`)
      .then((body) => setProject(parse(ProjectBody, body, "project").project))
      .catch((caught: unknown) => setError(String(caught)));
  }, [api, id]);
  const loaded = useLatestLoad(
    useCallback(
      () =>
        api.get(`projects/${id}/config`).then((body) => parse(ConfigBody, body, "project config")),
      [api, id],
    ),
  );
  const config = loaded.data;
  const settings = useSaveSetting(`projects/${id}/settings`, loaded.load);

  const remove = async () => {
    if (!project) return;
    const yes = await confirm({
      title: "Unregister project?",
      message: `Unregister ${project.name}? Its files stay where they are.`,
      confirmLabel: "Unregister",
      tone: "danger",
    });
    if (!yes) return;
    api
      .send("DELETE", `projects/${project.id}`)
      .then(() => {
        window.location.hash = "#/projects";
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  };

  return (
    <Page>
      <PageHeader title={project?.name ?? "Project"} above={<a href="#/projects">Projects</a>}>
        {project && (
          <>
            <Button variant="primary" asChild>
              <a href={`#/workspaces/in/${project.id}`}>Workspaces</a>
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Unregister
            </Button>
          </>
        )}
      </PageHeader>
      {dialog}
      {settings.dialog}
      {error && <Notice tone="fail">{error}</Notice>}
      {loaded.error && <Notice tone="fail">{loaded.error}</Notice>}
      {project && (
        <div className="flex flex-wrap items-center gap-2">
          <Chip mono>{project.vcs}</Chip>
          <TraitChips project={project} />
          <code className="text-muted">{project.path}</code>
        </div>
      )}
      {config && (
        <Panel>
          <PanelHeader title="Settings" />
          <div className="flex flex-col gap-3">
            {config.warnings.map((warning) => (
              <Notice key={warning} tone="warn">
                {warning}
              </Notice>
            ))}
            <Table>
              <tbody>
                <SettingRow
                  label="Copy into new worktrees"
                  settingKey="worktree.copy"
                  {...config.config.worktreeCopy}
                  shown={config.config.worktreeCopy.value.join(", ") || "(nothing)"}
                  save={settings.save}
                  stale={loaded.error !== undefined}
                />
                <SettingRow
                  label="Branch prefix"
                  settingKey="worktree.branch_prefix"
                  {...config.config.branchPrefix}
                  save={settings.save}
                  stale={loaded.error !== undefined}
                />
              </tbody>
            </Table>
            <p className="m-0 text-sm text-muted">
              Edit and Reset save to <code>.pi-spore/config.local.toml</code> (yours only). They
              never write <code>.pi-spore/config.toml</code> (committed).
            </p>
          </div>
        </Panel>
      )}
    </Page>
  );
}

function showValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const errorText = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/**
 * Loads with `fetch` now and on each `load()`. An answer that a newer load replaced never shows, and the promise ends
 * once the newest answer shows, so a row stays busy until it sees its own change. It rejects when the newest load
 * fails, so a save does not count as done while the page still shows the old value.
 */
function useLatestLoad<T>(fetch: () => Promise<T>): {
  data: T | undefined;
  error: string | undefined;
  load: () => Promise<void>;
} {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const latest = useRef<Promise<void>>(undefined);
  const load = useCallback(() => {
    const run: Promise<void> = fetch()
      .then(
        (value) => {
          if (latest.current !== run) return;
          setData(value);
          setError(undefined);
        },
        (caught: unknown) => {
          if (latest.current !== run) return;
          setError(errorText(caught));
          throw caught;
        },
      )
      .then(() => (latest.current === run ? undefined : latest.current));
    latest.current = run;
    return run;
  }, [fetch]);
  // The first load's error shows through `error`.
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);
  return { data, error, load };
}

/** Sends one change, then loads the panel again. False when the user said no. */
type SaveSetting = (body: SaveSettingRequest) => Promise<boolean>;

const remoteAccessKeys = new Set(["server.allowedHosts", "server.allowedLogins"]);

function useSaveSetting(
  path: string,
  reload: () => Promise<void>,
): { save: SaveSetting; dialog: ReactNode } {
  const api = useApi();
  const { confirm, dialog } = useConfirm();
  const save: SaveSetting = async (body) => {
    if (
      remoteAccessKeys.has(body.key) &&
      !(await confirm({
        title: "Change remote access?",
        message: "A wrong value can lock you out of remote access.",
        confirmLabel: "Change",
        tone: "danger",
      }))
    ) {
      return false;
    }
    await api.send("PUT", path, body);
    // The server resolves the value and its source; the page never guesses them.
    await reload().catch((caught: unknown) => {
      throw new Error(`Saved, but the new value did not load: ${errorText(caught)}`);
    });
    return true;
  };
  return { save, dialog };
}

/**
 * One setting. With `save`, it gets Edit and Reset (ADR 0170). `stale` means the panel's last load failed, so the shown
 * value may be old: Edit and Reset wait for a load that works.
 */
function SettingRow({
  label,
  settingKey,
  value,
  source,
  shown = showValue(value),
  save,
  stale = false,
}: {
  label?: string;
  settingKey: string;
  value: unknown;
  source: string;
  shown?: string;
  save?: SaveSetting | undefined;
  stale?: boolean | undefined;
}) {
  const [text, setText] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const multiline = typeof value === "object" && value !== null;

  const run = async (body: () => SaveSettingRequest) => {
    if (!save) return;
    setError(undefined);
    setBusy(true);
    try {
      if (!(await save(body()))) return;
      setText(undefined);
      setRestart(/^(agents|server)\./.test(settingKey));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const edit = () => {
    setError(undefined);
    setText(
      typeof value === "string" ? value : (JSON.stringify(value, null, multiline ? 2 : 0) ?? ""),
    );
  };
  // Broken JSON throws inside `run`, so the row shows the parse error and nothing is sent.
  const saveText = (draft: string) =>
    run(() => ({
      key: settingKey,
      value: typeof value === "string" ? draft : JSON.parse(draft),
    }));

  return (
    <tr>
      <TableHead className="w-72">{label ?? <code>{settingKey}</code>}</TableHead>
      <TableCell>
        <div className="flex flex-col gap-2">
          {/* JSON values have no spaces; without this, one long value pushes Edit and Reset off screen. */}
          <code className="[overflow-wrap:anywhere]">{shown}</code>
          {text !== undefined && (
            <div className="flex flex-wrap items-start gap-2">
              {multiline ? (
                <Textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={6}
                  aria-label={settingKey}
                  className="min-w-64 flex-1 font-mono"
                />
              ) : (
                <Input
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  aria-label={settingKey}
                  className="min-w-48 flex-1 font-mono"
                />
              )}
              <Button variant="primary" disabled={busy} onClick={() => void saveText(text)}>
                Save
              </Button>
              <Button disabled={busy} onClick={() => setText(undefined)}>
                Cancel
              </Button>
            </div>
          )}
          {error && <Notice tone="fail">{error}</Notice>}
          {restart && <p className="m-0 text-sm text-muted">Restart pi-spore to apply.</p>}
        </div>
      </TableCell>
      <TableCell className="w-32 text-right">
        <Chip>{source}</Chip>
      </TableCell>
      {save && (
        <TableCell className="w-40 text-right whitespace-nowrap">
          {text === undefined && (
            <span className="inline-flex gap-1">
              <Button disabled={busy || stale} onClick={edit}>
                Edit
              </Button>
              <Button
                disabled={busy || stale}
                onClick={() => void run(() => ({ key: settingKey, unset: true }))}
              >
                Reset
              </Button>
            </span>
          )}
        </TableCell>
      )}
    </tr>
  );
}

function SettingsTable({
  entries,
  save,
  stale,
}: {
  entries: SettingsView["settings"];
  save?: SaveSetting;
  stale?: boolean | undefined;
}) {
  return (
    <Table>
      <tbody>
        {entries.map((entry) => (
          <SettingRow
            key={entry.key}
            settingKey={entry.key}
            value={entry.value}
            source={entry.source}
            save={save}
            stale={stale}
          />
        ))}
      </tbody>
    </Table>
  );
}

function WorkspaceSettingsPanel() {
  const api = useApi();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [picked, setPicked] = useState("");
  const [view, setView] = useState<SettingsView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .get("workspaces?state=active")
      .then((body) => setWorkspaces(parse(WorkspaceList, body, "workspace list").workspaces))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [api]);

  // The cleanup drops the answer of an earlier pick, so a slow request cannot show under a later one.
  useEffect(() => {
    setView(undefined);
    setError(undefined);
    if (!picked) return;
    let current = true;
    api
      .get(`workspaces/${picked}/settings`)
      .then((body) => {
        if (current) setView(parse(SettingsView, body, "workspace settings"));
      })
      .catch((caught: unknown) => {
        if (current) setError(errorText(caught));
      });
    return () => {
      current = false;
    };
  }, [api, picked]);

  return (
    <Panel>
      <PanelHeader title="Workspace settings" />
      <div className="flex flex-col gap-3">
        <Select
          value={picked}
          onChange={(event) => setPicked(event.target.value)}
          aria-label="Workspace"
        >
          <option value="">Pick a workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </Select>
        {error && <Notice tone="fail">{error}</Notice>}
        {picked && !view && !error && <p className="text-muted">Loading...</p>}
        {view && <SettingsTable entries={view.settings} />}
        <p className="m-0 text-sm text-muted">
          A workspace or run gets an override when it is made, with <code>--set key=value</code> in
          the CLI. It beats every file. Workspace settings are fixed when the workspace is made, so
          this list is read-only.
        </p>
      </div>
    </Panel>
  );
}

function SettingsPage() {
  const api = useApi();
  const {
    data: view,
    error,
    load,
  } = useLatestLoad(
    useCallback(
      () => api.get("projects/settings").then((body) => parse(SettingsView, body, "settings")),
      [api],
    ),
  );
  const settings = useSaveSetting("projects/settings", load);

  return (
    <Page>
      <PageHeader title="Settings" />
      {settings.dialog}
      <Panel>
        <PanelHeader title="Global settings" />
        <div className="flex flex-col gap-3">
          {error && <Notice tone="fail">{error}</Notice>}
          {!view && !error && <p className="text-muted">Loading...</p>}
          {view && (
            <SettingsTable
              entries={view.settings}
              save={settings.save}
              stale={error !== undefined}
            />
          )}
          <p className="m-0 text-sm text-muted">
            Edit and Reset save to <code>~/.pi-spore/settings.json</code>. Reset removes the key, so
            the default applies. A project can also set some keys on its own page; a later source
            wins. The <code>agents.*</code> and <code>server.*</code> keys apply after a restart.
          </p>
        </div>
      </Panel>
      <WorkspaceSettingsPanel />
    </Page>
  );
}

export const projectsWeb: WebModule = {
  id: "projects",
  requires: [],
  core: true,
  setup(host) {
    host.addPage({
      path: "/projects",
      title: "Projects",
      rail: { order: 20, icon: FolderGit2 },
      component: ProjectsPage,
    });
    host.addPage({ path: "/projects/:id", title: "Project", component: ProjectPage });
    host.addPage({
      path: "/settings",
      title: "Settings",
      rail: { order: 90, icon: Settings },
      component: SettingsPage,
    });
  },
};
