import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  Project,
  ProjectConfigView,
  ProjectList,
  parse,
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
  useConfirm,
} from "@pi-spore/ui";
import { FolderGit2, Settings } from "lucide-react";
import { type SubmitEvent, useCallback, useEffect, useState } from "react";
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
  const [config, setConfig] = useState<
    { config: ProjectConfigView; warnings: string[] } | undefined
  >();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .get(`projects/${id}`)
      .then((body) => setProject(parse(ProjectBody, body, "project").project))
      .catch((caught: unknown) => setError(String(caught)));
    api
      .get(`projects/${id}/config`)
      .then((body) => setConfig(parse(ConfigBody, body, "project config")))
      .catch((caught: unknown) => setError(String(caught)));
  }, [api, id]);

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
      {error && <Notice tone="fail">{error}</Notice>}
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
                <tr>
                  <TableHead className="w-56">Copy into new worktrees</TableHead>
                  <TableCell>
                    <code>{config.config.worktreeCopy.value.join(", ") || "(nothing)"}</code>
                  </TableCell>
                  <TableCell className="w-24 text-right">
                    <Chip>{config.config.worktreeCopy.source}</Chip>
                  </TableCell>
                </tr>
                <tr>
                  <TableHead>Branch prefix</TableHead>
                  <TableCell>
                    <code>{config.config.branchPrefix.value}</code>
                  </TableCell>
                  <TableCell className="text-right">
                    <Chip>{config.config.branchPrefix.source}</Chip>
                  </TableCell>
                </tr>
              </tbody>
            </Table>
            <p className="m-0 text-sm text-muted">
              Change these in <code>.pi-spore/config.toml</code> (committed) or{" "}
              <code>.pi-spore/config.local.toml</code> (yours only).
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

function SettingsTable({ entries }: { entries: SettingsView["settings"] }) {
  return (
    <Table>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.key}>
            <TableHead className="w-72">
              <code>{entry.key}</code>
            </TableHead>
            <TableCell>
              <code>{showValue(entry.value)}</code>
            </TableCell>
            <TableCell className="w-32 text-right">
              <Chip>{entry.source}</Chip>
            </TableCell>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const errorText = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

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
          the CLI. It beats every file.
        </p>
      </div>
    </Panel>
  );
}

function SettingsPage() {
  const api = useApi();
  const [view, setView] = useState<SettingsView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .get("projects/settings")
      .then((body) => setView(parse(SettingsView, body, "settings")))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [api]);

  return (
    <Page>
      <PageHeader title="Settings" />
      <Panel>
        <PanelHeader title="Global settings" />
        <div className="flex flex-col gap-3">
          {error && <Notice tone="fail">{error}</Notice>}
          {!view && !error && <p className="text-muted">Loading...</p>}
          {view && <SettingsTable entries={view.settings} />}
          <p className="m-0 text-sm text-muted">
            Set a value in <code>~/.pi-spore/settings.json</code>, in nested form such as{" "}
            <code>{'{ "agents": { "maxLive": 4 } }'}</code>. Settings that a project can set also go
            in <code>.pi-spore/config.toml</code> (committed) and{" "}
            <code>.pi-spore/config.local.toml</code> (yours only); a later source wins. The{" "}
            <code>agents.*</code> keys apply after a server restart. Model choices never go in{" "}
            <code>config.toml</code>.
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
