import { ApiRequestError, useApi, type WebModule } from "@pi-spore/module-api";
import {
  CreateWorkspaceResponse,
  type Isolation,
  type Project,
  ProjectLines,
  ProjectList,
  parse,
  type Workspace,
  WorkspaceList,
} from "@pi-spore/shared";
import { type SubmitEvent, useCallback, useEffect, useState } from "react";

const MODE_LABELS: Record<Isolation, string> = {
  new: "New worktree on a new branch",
  existing: "Worktree on an existing branch",
  "in-place": "Main checkout (no copy)",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function CreateForm({
  project,
  onCreated,
}: {
  project: Project;
  onCreated: (notes: string[]) => void;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Isolation>("new");
  const [lines, setLines] = useState<string[]>([]);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const modes: Isolation[] =
    project.vcs === "git" ? ["new", "existing", "in-place"] : ["new", "in-place"];

  useEffect(() => {
    if (project.vcs !== "git") return;
    api
      .get(`projects/${project.id}/lines`)
      .then((body) => {
        const result = parse(ProjectLines, body, "branches");
        setLines(result.lines);
        setLine(
          result.lines.find((candidate) => candidate !== result.current) ?? result.lines[0] ?? "",
        );
      })
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, project]);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    api
      .send("POST", "workspaces", {
        projectId: project.id,
        name: name.trim(),
        isolation: mode,
        ...(mode === "existing" ? { line } : {}),
      })
      .then((body) => {
        const result = parse(CreateWorkspaceResponse, body, "create workspace");
        setName("");
        onCreated([
          ...result.warnings,
          ...(result.copied.length
            ? [`Copied into the worktree: ${result.copied.join(", ")}`]
            : []),
        ]);
      })
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <form className="inline" onSubmit={submit}>
      <label>
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Fix crafting UI"
          size={30}
        />
      </label>
      <label>
        Where
        <select value={mode} onChange={(event) => setMode(event.target.value as Isolation)}>
          {modes.map((candidate) => (
            <option key={candidate} value={candidate}>
              {MODE_LABELS[candidate]}
            </option>
          ))}
        </select>
      </label>
      {mode === "existing" && (
        <label>
          Branch
          <select value={line} onChange={(event) => setLine(event.target.value)}>
            {lines.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" disabled={busy || name.trim() === "" || (mode === "existing" && !line)}>
        {busy ? "Creating..." : "Start workspace"}
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function WorkspacesPage({ params }: { params: Readonly<Record<string, string>> }) {
  const api = useApi();
  const projectId = params.projectId;
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[] | undefined>();
  const [showArchived, setShowArchived] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    api
      .get(`workspaces${query}`)
      .then((body) => setWorkspaces(parse(WorkspaceList, body, "workspace list").workspaces))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, projectId]);

  useEffect(() => {
    api
      .get("projects")
      .then((body) => setProjects(parse(ProjectList, body, "project list").projects))
      .catch((caught: unknown) => setError(message(caught)));
    load();
  }, [api, load]);

  const act = (promise: Promise<unknown>) =>
    promise.then(load).catch((caught: unknown) => setError(message(caught)));

  const rename = (workspace: Workspace) => {
    const name = window.prompt("New name", workspace.name)?.trim();
    if (name && name !== workspace.name)
      act(api.send("PATCH", `workspaces/${workspace.id}`, { name }));
  };

  const archive = async (workspace: Workspace) => {
    const what =
      workspace.isolation === "in-place" ? "" : " Its copy will be removed; the branch stays.";
    if (!window.confirm(`Archive "${workspace.name}"?${what}`)) return;
    try {
      await api.send("POST", `workspaces/${workspace.id}/archive`, {});
    } catch (caught) {
      if (!(caught instanceof ApiRequestError && caught.code === "uncommitted_work")) {
        setError(message(caught));
        return;
      }
      if (!window.confirm(`${caught.message}\n\nDelete the uncommitted work and archive anyway?`))
        return;
      await api
        .send("POST", `workspaces/${workspace.id}/archive`, { force: true })
        .catch((forced: unknown) => {
          setError(message(forced));
        });
    }
    load();
  };

  const project = projects.find((candidate) => candidate.id === projectId);
  const projectName = (id: string) => projects.find((candidate) => candidate.id === id)?.name ?? id;
  const shown = (workspaces ?? []).filter(
    (workspace) => showArchived || workspace.state !== "archived",
  );

  return (
    <section>
      {project ? (
        <>
          <p>
            <a href={`#/projects/${project.id}`}>{project.name}</a>
          </p>
          <h1>Workspaces</h1>
          <CreateForm
            project={project}
            onCreated={(created) => {
              setNotes(created);
              load();
            }}
          />
        </>
      ) : (
        <>
          <h1>Workspaces</h1>
          <p className="muted">To start a workspace, open a project from the Projects page.</p>
        </>
      )}
      {notes.map((note) => (
        <p key={note} className="warning">
          {note}
        </p>
      ))}
      {error && <p className="error">{error}</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        Show archived
      </label>
      {workspaces === undefined && !error && <p className="muted">Loading...</p>}
      {workspaces !== undefined && shown.length === 0 && <p className="muted">No workspaces.</p>}
      {shown.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              {!project && <th>Project</th>}
              <th>State</th>
              <th>Branch</th>
              <th>Folder</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((workspace) => (
              <tr key={workspace.id}>
                <td>{workspace.name}</td>
                {!project && <td>{projectName(workspace.projectId)}</td>}
                <td>
                  <span className="badge">{workspace.state}</span>
                </td>
                <td>
                  <code>{workspace.line ?? workspace.isolation}</code>
                </td>
                <td>
                  <code>{workspace.path}</code>
                </td>
                <td>
                  {workspace.state !== "archived" && (
                    <>
                      <button type="button" onClick={() => rename(workspace)}>
                        Rename
                      </button>{" "}
                      {workspace.state === "active" ? (
                        <button
                          type="button"
                          onClick={() => act(api.send("POST", `workspaces/${workspace.id}/park`))}
                        >
                          Park
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => act(api.send("POST", `workspaces/${workspace.id}/resume`))}
                        >
                          Resume
                        </button>
                      )}{" "}
                      <button type="button" onClick={() => void archive(workspace)}>
                        Archive
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export const workspacesWeb: WebModule = {
  id: "workspaces",
  requires: ["projects"],
  core: true,
  setup(host) {
    host.addPage({
      path: "/workspaces",
      title: "Workspaces",
      navOrder: 20,
      component: WorkspacesPage,
    });
    host.addPage({
      path: "/workspaces/in/:projectId",
      title: "Workspaces",
      component: WorkspacesPage,
    });
  },
};
