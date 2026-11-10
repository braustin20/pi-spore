import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import { readFileInside } from "@pi-spore/module-api/node";
import {
  type ArtifactInfo,
  type ArtifactsEvent,
  OpenArtifactFolderRequest,
  PromoteArtifactRequest,
  parseJsonBody,
  WriteArtifactRequest,
} from "@pi-spore/shared";
import { type ArtifactOwner, type Artifacts, ArtifactsKey } from "./contract.js";

export * from "./contract.js";

/** Topic of a workspace's artifact events: `artifacts:<workspace id>`. */
export const ARTIFACTS_TOPIC = "artifacts:";

// The disk holds the content. The row holds who wrote it, when, and where it came from (ADR 0070).
const MIGRATIONS = [
  `CREATE TABLE artifacts_artifacts (
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    path TEXT NOT NULL,
    written_by TEXT,
    promoted_from TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, owner_id, path)
  )`,
];

interface ArtifactRow {
  path: string;
  written_by: string | null;
  promoted_from: string | null;
  updated_at: number;
}

export interface ArtifactsModuleOptions {
  /** Most bytes in one artifact, for a write and a read. */
  maxBytes?: number;
  /** Opens a folder in the file manager of this computer. Tests pass a fake. */
  openFolder?: (folder: string) => Promise<void>;
}

const FILE_MANAGERS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  linux: "xdg-open",
  darwin: "open",
  win32: "explorer",
};

/** Starts the platform's file manager on a folder and returns once it has started, not when it exits. */
export function createFolderOpener(platform: NodeJS.Platform): (folder: string) => Promise<void> {
  return async (folder) => {
    const program = FILE_MANAGERS[platform];
    if (program === undefined) {
      throw new ApiError(
        501,
        "unsupported_platform",
        `Open folder is not supported on ${platform}`,
      );
    }
    await new Promise<void>((resolveStart, reject) => {
      const child = spawn(program, [folder], { detached: true, stdio: "ignore" });
      child.once("error", (error) =>
        reject(new ApiError(500, "open_failed", `Could not start ${program}: ${error.message}`)),
      );
      child.once("spawn", () => {
        child.unref();
        resolveStart();
      });
    });
  };
}

const MAX_PATH_CHARS = 255;

/** What the viewer shows (R14.2): Markdown and images only, so `.env` and other repo files stay unreadable. */
const VIEW_TYPES: Readonly<Record<string, string>> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const TYPES: Readonly<Record<string, string>> = {
  ...VIEW_TYPES,
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".json": "application/json",
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

const isUtf8 = (bytes: Uint8Array): boolean => {
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** Headers for artifact bytes: a type by extension, and nothing in the file may run (a sandboxed page cannot script). */
function byteHeaders(name: string, bytes: Uint8Array): Record<string, string> {
  const known = TYPES[extname(name).toLowerCase()];
  const type = known ?? (isUtf8(bytes) ? "text/plain; charset=utf-8" : "application/octet-stream");
  return {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
}

/** One rule for every artifact path, so a path can never name a place outside the owner's folder. */
function checkPath(path: string): void {
  const bad = (why: string) => new ApiError(400, "bad_path", `Bad artifact path "${path}": ${why}`);
  if (path === "") throw bad("it is empty");
  if (path.length > MAX_PATH_CHARS) throw bad(`it is longer than ${MAX_PATH_CHARS} characters`);
  if (path.includes("\\")) throw bad("use / between folders, not \\");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this refuses
  if (/[\x00-\x1f\x7f]/.test(path)) throw bad("it has a control character");
  if (path.startsWith("/")) throw bad("it must be relative");
  for (const segment of path.split("/")) {
    if (segment === "") throw bad("it has an empty folder name");
    if (segment === "." || segment === "..") throw bad(`it has a "${segment}" folder name`);
  }
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

const outsideRoot = (path: string) =>
  new ApiError(403, "outside_root", `${path} leads outside the artifacts folder`);

interface Found {
  path: string;
  bytes: number;
  mtime: number;
}

/** Regular files under `root`, as paths relative to it. Symlinks are skipped, so a link cannot lead a list out. */
async function walk(root: string, prefix = ""): Promise<Found[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch((error) => {
    if (errnoOf(error) === "ENOENT") return [];
    throw error;
  });
  const found: Found[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await walk(root, path)));
    else if (entry.isFile()) {
      const info = await stat(join(root, path));
      found.push({ path, bytes: info.size, mtime: Math.floor(info.mtimeMs) });
    }
  }
  return found;
}

/** Defaults: 10 MiB per artifact. */
export function createArtifactsModule(options: ArtifactsModuleOptions = {}): ServerModule {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const openFolder = options.openFolder ?? createFolderOpener(process.platform);
  return {
    id: "artifacts",
    requires: ["projects", "workspaces"],
    core: true,
    setup(host) {
      host.store.migrate("artifacts", MIGRATIONS);
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);

      const rootOf = (owner: ArtifactOwner) =>
        join(host.home.artifacts, `${owner.scope}s`, owner.id);

      // A workspace stays an owner after it is archived: artifacts outlive the working copy (R14.3, ADR 0121).
      const checkOwner = async (owner: ArtifactOwner): Promise<void> => {
        if (owner.scope === "workspace") workspaces.get(owner.id);
        else await projects.get(owner.id);
      };

      const rowsOf = (owner: ArtifactOwner): Map<string, ArtifactRow> =>
        new Map(
          host.store
            .all<ArtifactRow>(
              "SELECT path, written_by, promoted_from, updated_at FROM artifacts_artifacts WHERE scope = ? AND owner_id = ?",
              owner.scope,
              owner.id,
            )
            .map((row) => [row.path, row]),
        );

      const infoOf = (
        owner: ArtifactOwner,
        path: string,
        file: { bytes: number; mtime: number },
        row: ArtifactRow | undefined,
      ): ArtifactInfo => ({
        scope: owner.scope,
        ownerId: owner.id,
        path,
        bytes: file.bytes,
        updatedAt: row?.updated_at ?? file.mtime,
        ...(row?.written_by ? { writtenBy: row.written_by } : {}),
        ...(row?.promoted_from ? { promotedFrom: row.promoted_from } : {}),
      });

      const listFolder = async (owner: ArtifactOwner): Promise<ArtifactInfo[]> => {
        const rows = rowsOf(owner);
        const files = await walk(rootOf(owner));
        return files
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .map((file) => infoOf(owner, file.path, file, rows.get(file.path)));
      };

      const snapshot = async (workspaceId: string): Promise<ArtifactsEvent> => {
        const workspace = workspaces.get(workspaceId);
        return {
          type: "artifacts",
          workspace: await listFolder({ scope: "workspace", id: workspace.id }),
          project: await listFolder({ scope: "project", id: workspace.projectId }),
        };
      };

      host.events.onSubscribe(ARTIFACTS_TOPIC, async (topic) => [
        await snapshot(topic.slice(ARTIFACTS_TOPIC.length)),
      ]);

      // A project's artifacts show in every one of its workspaces, so all of them get the fresh lists.
      const publishChange = async (owner: ArtifactOwner): Promise<void> => {
        const ids =
          owner.scope === "workspace"
            ? [owner.id]
            : workspaces.list({ projectId: owner.id }).map((workspace) => workspace.id);
        for (const id of ids) host.events.publish(`${ARTIFACTS_TOPIC}${id}`, await snapshot(id));
      };

      /** Makes each folder of `path` inside the owner's folder, refusing one that is a link leading outside. */
      const makeFolders = async (root: string, path: string): Promise<void> => {
        await mkdir(root, { recursive: true });
        const realRoot = await realpath(root);
        let current = root;
        for (const segment of path.split("/").slice(0, -1)) {
          current = join(current, segment);
          // One folder at a time: a recursive mkdir through a link would create folders outside the root.
          await mkdir(current).catch((error) => {
            if (errnoOf(error) !== "EEXIST") throw error;
          });
          const real = await realpath(current).catch(() => undefined);
          if (real === undefined || !inside(real, realRoot)) throw outsideRoot(path);
        }
      };

      const store = async (
        owner: ArtifactOwner,
        path: string,
        data: string | Buffer,
        agentId: string | undefined,
        promotedFrom?: string,
      ): Promise<ArtifactInfo> => {
        checkPath(path);
        await checkOwner(owner);
        const bytes = Buffer.byteLength(data);
        if (bytes > maxBytes) {
          throw new ApiError(
            413,
            "artifact_too_large",
            `The artifact is ${bytes} bytes; the limit is ${maxBytes}`,
          );
        }
        const root = rootOf(owner);
        await makeFolders(root, path);
        // Promote never replaces. O_NOFOLLOW refuses a link at the file name itself.
        const flags =
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          (promotedFrom === undefined ? constants.O_TRUNC : constants.O_EXCL);
        const handle = await open(join(root, path), flags).catch((error) => {
          switch (errnoOf(error)) {
            case "ELOOP":
              throw outsideRoot(path);
            case "EEXIST":
              throw new ApiError(
                409,
                "artifact_exists",
                `${owner.scope} ${owner.id} has ${path} already`,
              );
            case "EISDIR":
            case "ENOTDIR":
              throw new ApiError(409, "path_conflict", `${path} clashes with a folder or file`);
          }
          throw error;
        });
        let mtime: number;
        try {
          await handle.writeFile(data);
          mtime = Math.floor((await handle.stat()).mtimeMs);
        } finally {
          await handle.close();
        }
        const row: ArtifactRow = {
          path,
          written_by: agentId ?? null,
          promoted_from: promotedFrom ?? null,
          updated_at: host.now(),
        };
        host.store.run(
          `INSERT INTO artifacts_artifacts (scope, owner_id, path, written_by, promoted_from, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope, owner_id, path) DO UPDATE SET
             written_by = excluded.written_by,
             promoted_from = excluded.promoted_from,
             updated_at = excluded.updated_at`,
          owner.scope,
          owner.id,
          path,
          row.written_by,
          row.promoted_from,
          row.updated_at,
        );
        await publishChange(owner);
        return infoOf(owner, path, { bytes, mtime }, row);
      };

      const artifacts: Artifacts = {
        async list(owner) {
          await checkOwner(owner);
          return await listFolder(owner);
        },
        async read(owner, path) {
          checkPath(path);
          await checkOwner(owner);
          const root = rootOf(owner);
          const { real, bytes } = await readFileInside(join(root, path), [root], maxBytes);
          const file = { bytes: bytes.length, mtime: Math.floor((await stat(real)).mtimeMs) };
          return { info: infoOf(owner, path, file, rowsOf(owner).get(path)), bytes };
        },
        write: (owner, path, content, agentId) => store(owner, path, content, agentId),
        async promote(workspaceId, path, agentId) {
          const workspace = workspaces.get(workspaceId);
          const { bytes } = await artifacts.read({ scope: "workspace", id: workspace.id }, path);
          return await store(
            { scope: "project", id: workspace.projectId },
            path,
            bytes,
            agentId,
            workspace.id,
          );
        },
      };
      host.provide(ArtifactsKey, artifacts);

      const sendBytes = (
        c: { body: (data: Uint8Array, status: 200, headers: Record<string, string>) => Response },
        name: string,
        bytes: Buffer,
      ) => c.body(new Uint8Array(bytes), 200, byteHeaders(name, bytes));

      // The core guard (ADR 0143, `guardRequest`) already refuses a non-loopback peer. `tailscale serve` connects
      // from loopback, so its headers are what mark a remote request.
      const isLocal = (c: { req: { header(name: string): string | undefined } }) =>
        c.req.header("x-forwarded-for") === undefined &&
        c.req.header("tailscale-user-login") === undefined;

      host.routes.get("/local", (c) => c.json({ local: isLocal(c) }));

      for (const scope of ["workspace", "project"] as const) {
        const owner = (id: string): ArtifactOwner => ({ scope, id });

        host.routes.get(`/${scope}s/:id`, async (c) =>
          c.json({ artifacts: await artifacts.list(owner(c.req.param("id"))) }),
        );

        host.routes.get(`/${scope}s/:id/file`, async (c) => {
          const path = c.req.query("path") ?? "";
          const { bytes } = await artifacts.read(owner(c.req.param("id")), path);
          return sendBytes(c, path, bytes);
        });

        host.routes.post(`/${scope}s/:id/file`, async (c) => {
          const request = parseJsonBody(WriteArtifactRequest, await c.req.text(), "artifact");
          return c.json(
            await artifacts.write(owner(c.req.param("id")), request.path, request.content),
          );
        });

        host.routes.post(`/${scope}s/:id/open-folder`, async (c) => {
          if (!isLocal(c)) {
            throw new ApiError(
              403,
              "not_local",
              "Open folder works only in a browser on the computer that runs pi-spore",
            );
          }
          const { path } = parseJsonBody(
            OpenArtifactFolderRequest,
            await c.req.text(),
            "open folder request",
          );
          checkPath(path);
          const target = owner(c.req.param("id"));
          await checkOwner(target);
          const root = rootOf(target);
          const notFound = (error: unknown) => {
            if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") {
              throw new ApiError(404, "artifact_not_found", `${scope} ${target.id} has no ${path}`);
            }
            throw error;
          };
          const real = await realpath(join(root, path)).catch(notFound);
          const realRoot = await realpath(root).catch(notFound);
          // Check the folder that opens, not the file: a link to the root itself would open the root's parent.
          const folder = dirname(real);
          if (!inside(folder, realRoot)) throw outsideRoot(path);
          await openFolder(folder);
          return c.json({ ok: true });
        });
      }

      host.routes.post("/workspaces/:id/promote", async (c) => {
        const request = parseJsonBody(PromoteArtifactRequest, await c.req.text(), "promotion");
        return c.json(await artifacts.promote(c.req.param("id"), request.path));
      });

      // R14.2: the viewer opens a Markdown or image file named by an absolute path or one relative to the workspace.
      host.routes.get("/workspaces/:id/view", async (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        const requested = c.req.query("path") ?? "";
        const path = isAbsolute(requested) ? requested : resolve(workspace.path, requested);
        const roots = [
          workspace.path,
          rootOf({ scope: "workspace", id: workspace.id }),
          rootOf({ scope: "project", id: workspace.projectId }),
        ];
        const { real, bytes } = await readFileInside(path, roots, maxBytes, (name) => {
          if (VIEW_TYPES[extname(name).toLowerCase()] === undefined) {
            throw new ApiError(
              415,
              "not_viewable",
              "The viewer shows Markdown and image files (.md, .markdown, .png, .jpg, .jpeg, .webp, .gif) only",
            );
          }
        });
        return sendBytes(c, real, bytes);
      });
    },
  };
}

export const artifactsModule = createArtifactsModule();
