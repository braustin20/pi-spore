import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type { ArtifactInfo, ArtifactList, ArtifactsEvent, Workspace } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACTS_TOPIC, createArtifactsModule, createFolderOpener } from "./server.js";

let server: TestServer;
let scratch: string;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-artifacts-")));
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    vcsFolderModule,
    workspacesModule,
    createArtifactsModule({ maxBytes: 1024 }),
  ]);
});
afterEach(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function errorCode(response: Response, status: number): Promise<string> {
  return (await json<{ error: { code: string } }>(response, status)).error.code;
}

/** A Git project with one commit and a workspace on a new branch. */
async function gitWorkspace(): Promise<Workspace> {
  const repo = join(scratch, "game");
  git(scratch, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "# Game\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: repo }),
    201,
  );
  const { workspace } = await json<{ workspace: Workspace }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "Fix it",
      isolation: "new",
    }),
    201,
  );
  return workspace;
}

const write = (scope: "workspaces" | "projects", id: string, path: string, content: string) =>
  server.request("POST", `/api/artifacts/${scope}/${id}/file`, { path, content });
const list = (scope: "workspaces" | "projects", id: string) =>
  server.request("GET", `/api/artifacts/${scope}/${id}`).then((r) => json<ArtifactList>(r));
const read = (scope: "workspaces" | "projects", id: string, path: string) =>
  server.request("GET", `/api/artifacts/${scope}/${id}/file?path=${encodeURIComponent(path)}`);
const view = (id: string, path: string) =>
  server.request("GET", `/api/artifacts/workspaces/${id}/view?path=${encodeURIComponent(path)}`);

describe("artifacts", () => {
  it("writes, lists, and reads files in both scopes, with nested paths", async () => {
    const workspace = await gitWorkspace();
    const projectId = workspace.projectId;

    const info = await json<ArtifactInfo>(
      await write("workspaces", workspace.id, "runs/spec.md", "# Spec\n"),
    );
    expect(info).toMatchObject({
      scope: "workspace",
      ownerId: workspace.id,
      path: "runs/spec.md",
      bytes: 7,
    });
    expect(info.writtenBy).toBeUndefined();
    await json(await write("projects", projectId, "notes.md", "shared"));

    const mine = await list("workspaces", workspace.id);
    expect(mine.artifacts.map((a) => a.path)).toEqual(["runs/spec.md"]);
    expect((await list("projects", projectId)).artifacts.map((a) => a.path)).toEqual(["notes.md"]);

    const response = await read("workspaces", workspace.id, "runs/spec.md");
    expect(await response.text()).toBe("# Spec\n");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      existsSync(join(server.paths.artifacts, "workspaces", workspace.id, "runs", "spec.md")),
    ).toBe(true);
    expect(existsSync(join(server.paths.artifacts, "projects", projectId, "notes.md"))).toBe(true);
    expect(existsSync(join(workspace.path, "runs"))).toBe(false);
  });

  it("overwrites a file and updates its row", async () => {
    const workspace = await gitWorkspace();
    const first = await json<ArtifactInfo>(await write("workspaces", workspace.id, "a.md", "one"));
    const second = await json<ArtifactInfo>(
      await write("workspaces", workspace.id, "a.md", "longer text"),
    );
    expect(second.bytes).toBe(11);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await (await read("workspaces", workspace.id, "a.md")).text()).toBe("longer text");
    expect((await list("workspaces", workspace.id)).artifacts).toEqual([second]);
  });

  it("refuses a file over the size limit", async () => {
    const workspace = await gitWorkspace();
    const response = await write("workspaces", workspace.id, "big.txt", "x".repeat(1025));
    expect(await errorCode(response, 413)).toBe("artifact_too_large");
  });

  it("promotes a workspace file to the project, keeps the original, and never replaces", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "runs/spec.md", "# Spec\n"));

    const promoted = await json<ArtifactInfo>(
      await server.request("POST", `/api/artifacts/workspaces/${workspace.id}/promote`, {
        path: "runs/spec.md",
      }),
    );
    expect(promoted).toMatchObject({
      scope: "project",
      ownerId: workspace.projectId,
      path: "runs/spec.md",
      promotedFrom: workspace.id,
    });
    expect(await (await read("projects", workspace.projectId, "runs/spec.md")).text()).toBe(
      "# Spec\n",
    );
    expect((await list("workspaces", workspace.id)).artifacts).toHaveLength(1);

    const again = await server.request(
      "POST",
      `/api/artifacts/workspaces/${workspace.id}/promote`,
      {
        path: "runs/spec.md",
      },
    );
    expect(await errorCode(again, 409)).toBe("artifact_exists");
  });

  it("refuses bad paths with 400 bad_path", async () => {
    const workspace = await gitWorkspace();
    for (const path of [
      "../x",
      "/abs",
      "a//b",
      "a\\b",
      "a\0b",
      "",
      "a/./b",
      "x/..",
      "a".repeat(256),
    ]) {
      expect(await errorCode(await write("workspaces", workspace.id, path, "x"), 400)).toBe(
        "bad_path",
      );
    }
    expect(await errorCode(await read("workspaces", workspace.id, "../x"), 400)).toBe("bad_path");
  });

  it("refuses a symlink that leads out of the artifacts folder, on read and write", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "keep.md", "ok"));
    const root = join(server.paths.artifacts, "workspaces", workspace.id);
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "secret.txt"), join(root, "file-link.md"));

    expect(await errorCode(await read("workspaces", workspace.id, "link/secret.txt"), 403)).toBe(
      "outside_root",
    );
    expect(await errorCode(await read("workspaces", workspace.id, "file-link.md"), 403)).toBe(
      "outside_root",
    );
    expect(await errorCode(await write("workspaces", workspace.id, "link/new.md", "x"), 403)).toBe(
      "outside_root",
    );
    expect(await errorCode(await write("workspaces", workspace.id, "file-link.md", "x"), 403)).toBe(
      "outside_root",
    );
    expect(existsSync(join(outside, "new.md"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
    // The list skips links, so nothing outside shows in it.
    expect((await list("workspaces", workspace.id)).artifacts.map((a) => a.path)).toEqual([
      "keep.md",
    ]);
  });

  it("answers 404 for an unknown workspace or project", async () => {
    await gitWorkspace();
    expect(
      await errorCode(await server.request("GET", "/api/artifacts/workspaces/nope"), 404),
    ).toBe("workspace_not_found");
    expect(await errorCode(await write("projects", "nope", "a.md", "x"), 404)).toBe(
      "project_not_found",
    );
  });

  it("keeps artifacts after the workspace is archived", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "spec.md", "kept"));
    await json(
      await server.request("POST", `/api/workspaces/${workspace.id}/archive`, { force: true }),
    );
    expect((await list("workspaces", workspace.id)).artifacts.map((a) => a.path)).toEqual([
      "spec.md",
    ]);
    expect(await (await read("workspaces", workspace.id, "spec.md")).text()).toBe("kept");
  });

  it("views Markdown from the workspace folder and its artifacts folders, and nothing else", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "spec.md", "mine"));
    await json(await write("projects", workspace.projectId, "shared.md", "shared"));
    writeFileSync(join(workspace.path, "notes.md"), "# Notes\n");
    writeFileSync(join(dirname(workspace.path), "outside.md"), "outside");

    const relative = await view(workspace.id, "README.md");
    expect(await relative.text()).toBe("# Game\n");
    expect(relative.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await (await view(workspace.id, join(workspace.path, "notes.md"))).text()).toBe(
      "# Notes\n",
    );
    const mine = join(server.paths.artifacts, "workspaces", workspace.id, "spec.md");
    expect(await (await view(workspace.id, mine)).text()).toBe("mine");
    const shared = join(server.paths.artifacts, "projects", workspace.projectId, "shared.md");
    expect(await (await view(workspace.id, shared)).text()).toBe("shared");

    expect(await errorCode(await view(workspace.id, ".env"), 415)).toBe("not_viewable");
    expect(await errorCode(await view(workspace.id, "../outside.md"), 403)).toBe("outside_root");
    expect(await errorCode(await view(workspace.id, "missing.md"), 404)).toBe("file_not_found");
  });

  it("sends a snapshot on subscribe and fresh lists after a write", async () => {
    const workspace = await gitWorkspace();
    const topic = `${ARTIFACTS_TOPIC}${workspace.id}`;
    expect(await server.events.snapshot(topic)).toEqual([
      { type: "artifacts", workspace: [], project: [] },
    ]);

    await json(await write("workspaces", workspace.id, "a.md", "one"));
    await json(await write("projects", workspace.projectId, "b.md", "two"));

    const events = server.events.eventsOf(topic) as ArtifactsEvent[];
    expect(events).toHaveLength(2);
    expect(events[0]?.workspace.map((a) => a.path)).toEqual(["a.md"]);
    expect(events[0]?.project).toEqual([]);
    expect(events[1]?.workspace.map((a) => a.path)).toEqual(["a.md"]);
    expect(events[1]?.project.map((a) => a.path)).toEqual(["b.md"]);
  });
});

describe("open folder", () => {
  const opened = vi.fn<(folder: string) => Promise<void>>();

  beforeEach(async () => {
    opened.mockReset();
    opened.mockResolvedValue(undefined);
    server.close();
    server = await createTestServer([
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      createArtifactsModule({ maxBytes: 1024, openFolder: opened }),
    ]);
  });

  const openFolder = (
    scope: "workspaces" | "projects",
    id: string,
    path: string,
    headers?: Record<string, string>,
  ) => server.request("POST", `/api/artifacts/${scope}/${id}/open-folder`, { path }, headers);

  it("opens the real folder that holds a workspace or project artifact", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "runs/spec.md", "# Spec\n"));
    await json(await write("projects", workspace.projectId, "notes/a.md", "shared"));

    expect(await json(await openFolder("workspaces", workspace.id, "runs/spec.md"))).toEqual({
      ok: true,
    });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(
      realpathSync(join(server.paths.artifacts, "workspaces", workspace.id, "runs")),
    );

    await json(await openFolder("projects", workspace.projectId, "notes/a.md"));
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenLastCalledWith(
      realpathSync(join(server.paths.artifacts, "projects", workspace.projectId, "notes")),
    );
  });

  it("refuses a bad path with 400 bad_path", async () => {
    const workspace = await gitWorkspace();
    expect(await errorCode(await openFolder("workspaces", workspace.id, "../x.md"), 400)).toBe(
      "bad_path",
    );
    expect(opened).not.toHaveBeenCalled();
  });

  it("refuses a symlink that leads out of the artifacts folder", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "keep.md", "ok"));
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(
      join(outside, "secret.txt"),
      join(server.paths.artifacts, "workspaces", workspace.id, "file-link.md"),
    );
    expect(await errorCode(await openFolder("workspaces", workspace.id, "file-link.md"), 403)).toBe(
      "outside_root",
    );
    expect(opened).not.toHaveBeenCalled();
  });

  it("refuses a link to the artifacts folder itself, so the parent never opens", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "keep.md", "ok"));
    const root = join(server.paths.artifacts, "workspaces", workspace.id);
    symlinkSync(root, join(root, "self.md"));
    expect(await errorCode(await openFolder("workspaces", workspace.id, "self.md"), 403)).toBe(
      "outside_root",
    );
    expect(opened).not.toHaveBeenCalled();
  });

  it("refuses a request that came through tailscale serve with 403 not_local", async () => {
    const workspace = await gitWorkspace();
    await json(await write("workspaces", workspace.id, "a.md", "x"));
    for (const headers of [
      { "x-forwarded-for": "1.2.3.4" },
      { "tailscale-user-login": "me@example.com" },
    ]) {
      expect(
        await errorCode(await openFolder("workspaces", workspace.id, "a.md", headers), 403),
      ).toBe("not_local");
    }
    expect(opened).not.toHaveBeenCalled();
  });

  it("answers 404 artifact_not_found for a missing file", async () => {
    const workspace = await gitWorkspace();
    expect(await errorCode(await openFolder("workspaces", workspace.id, "nope.md"), 404)).toBe(
      "artifact_not_found",
    );
    await json(await write("workspaces", workspace.id, "a.md", "x"));
    expect(await errorCode(await openFolder("workspaces", workspace.id, "a.md/b.md"), 404)).toBe(
      "artifact_not_found",
    );
    expect(opened).not.toHaveBeenCalled();
  });

  it("tells a browser on this computer from a remote one", async () => {
    const local = await server.request("GET", "/api/artifacts/local");
    expect(await json(local)).toEqual({ local: true });
    const remote = await server.request("GET", "/api/artifacts/local", undefined, {
      "x-forwarded-for": "1.2.3.4",
    });
    expect(await json(remote)).toEqual({ local: false });
  });

  it("rejects an unsupported platform with 501 unsupported_platform that names it", async () => {
    const error = await createFolderOpener("aix")("/tmp").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 501, code: "unsupported_platform" });
    expect((error as Error).message).toContain("aix");
  });
});
