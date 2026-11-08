import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  GlobalSettingsView,
  Project,
  ProjectConfigView,
  ProjectList,
  parse,
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
  Table,
  TableCell,
  TableHead,
} from "@pi-spore/ui";
import { FolderGit2 } from "lucide-react";
import { type SubmitEvent, useCallback, useEffect, useState } from "react";
import Type from "typebox";

const ConfigBody = Type.Object({ config: ProjectConfigView, warnings: Type.Array(Type.String()) });
const ProjectBody = Type.Object({ project: Project });
const GlobalSettingsBody = Type.Object({ settings: GlobalSettingsView });

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
  const [settings, setSettings] = useState<GlobalSettingsView | undefined>();
  const [settingsError, setSettingsError] = useState<string | undefined>();

  useEffect(() => {
    api
      .get("projects/settings")
      .then((body) => setSettings(parse(GlobalSettingsBody, body, "global settings").settings))
      .catch((caught: unknown) =>
        setSettingsError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [api]);

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
          <Field label="Folder (absolute path)" className="min-w-80 flex-1">
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
      <Panel>
        <PanelHeader title="Global settings" />
        <div className="flex flex-col gap-3">
          {settingsError && <Notice tone="fail">{settingsError}</Notice>}
          {settings && (
            <Table>
              <tbody>
                <tr>
                  <TableHead className="w-56">Delete finished work after</TableHead>
                  <TableCell>
                    <code>
                      {settings.retentionDays.value === 0
                        ? "never"
                        : `${settings.retentionDays.value} days`}
                    </code>
                  </TableCell>
                  <TableCell className="w-24 text-right">
                    <Chip>{settings.retentionDays.source}</Chip>
                  </TableCell>
                </tr>
              </tbody>
            </Table>
          )}
          <p className="m-0 text-sm text-muted">
            Change it in <code>~/.pi-spore/settings.json</code> (<code>retention.days</code>, 0
            keeps everything).
          </p>
        </div>
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

  const remove = () => {
    if (!project || !window.confirm(`Unregister ${project.name}? Its files stay where they are.`))
      return;
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
            <Button variant="danger" onClick={remove}>
              Unregister
            </Button>
          </>
        )}
      </PageHeader>
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
  },
};
