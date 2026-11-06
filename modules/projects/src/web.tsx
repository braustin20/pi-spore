import { useApi, type WebModule } from "@pi-spore/module-api";
import { Project, ProjectConfigView, ProjectList, parse } from "@pi-spore/shared";
import { type SubmitEvent, useCallback, useEffect, useState } from "react";
import Type from "typebox";

const ConfigBody = Type.Object({ config: ProjectConfigView, warnings: Type.Array(Type.String()) });
const ProjectBody = Type.Object({ project: Project });

function traitText(project: Project): string {
  return project.traits
    .map((trait) => (trait.detail ? `${trait.id} ${trait.detail}` : trait.id))
    .join(", ");
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
    <section>
      <h1>Projects</h1>
      <form className="inline" onSubmit={add}>
        <label>
          Folder (absolute path)
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/home/you/code/game"
            size={40}
          />
        </label>
        <label>
          Name (optional)
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" disabled={busy || path.trim() === ""}>
          Add project
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {projects === undefined && !error && <p className="muted">Loading...</p>}
      {projects?.length === 0 && (
        <p className="muted">No projects yet. Add a Git checkout or a folder above.</p>
      )}
      {projects && projects.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Detected</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <td>
                  <a href={`#/projects/${project.id}`}>{project.name}</a>
                </td>
                <td>
                  <span className="badge">{project.vcs}</span>
                </td>
                <td>{traitText(project) || <span className="muted">-</span>}</td>
                <td>
                  <code>{project.path}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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
    <section>
      <p>
        <a href="#/projects">Projects</a>
      </p>
      {error && <p className="error">{error}</p>}
      {project && (
        <>
          <h1>{project.name}</h1>
          <p>
            <span className="badge">{project.vcs}</span> <code>{project.path}</code>
            {project.traits.length > 0 && <span className="muted"> · {traitText(project)}</span>}
          </p>
          <p>
            <a href={`#/workspaces/in/${project.id}`}>Workspaces of this project</a>
          </p>
        </>
      )}
      {config && (
        <>
          <h2>Settings</h2>
          {config.warnings.map((warning) => (
            <p key={warning} className="warning">
              {warning}
            </p>
          ))}
          <table>
            <tbody>
              <tr>
                <th>Copy into new worktrees</th>
                <td>
                  <code>{config.config.worktreeCopy.value.join(", ") || "(nothing)"}</code>
                </td>
                <td>
                  <span className="badge">{config.config.worktreeCopy.source}</span>
                </td>
              </tr>
              <tr>
                <th>Branch prefix</th>
                <td>
                  <code>{config.config.branchPrefix.value}</code>
                </td>
                <td>
                  <span className="badge">{config.config.branchPrefix.source}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted">
            Change these in <code>.pi-spore/config.toml</code> (committed) or{" "}
            <code>.pi-spore/config.local.toml</code> (yours only).
          </p>
        </>
      )}
      {project && (
        <p>
          <button type="button" onClick={remove}>
            Unregister project
          </button>
        </p>
      )}
    </section>
  );
}

export const projectsWeb: WebModule = {
  id: "projects",
  requires: [],
  core: true,
  setup(host) {
    host.addPage({ path: "/projects", title: "Projects", navOrder: 10, component: ProjectsPage });
    host.addPage({ path: "/projects/:id", title: "Project", component: ProjectPage });
  },
};
