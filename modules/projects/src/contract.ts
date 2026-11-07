import { defineInterface } from "@pi-spore/module-api";
import type {
  ChangedFile,
  ChangeRecord,
  ChangeScope,
  ChangeScopeKind,
  FileDiff,
  Isolation,
  Project,
  ProjectConfigView,
  ProjectTrait,
} from "@pi-spore/shared";
import type { Static, TSchema } from "typebox";

/** Where a workspace's copy lives, as a provider made it. */
export interface WorkspaceLocation {
  path: string;
  /** Git: the branch. */
  line?: string;
  /** For a new line: what it started from (Git: the branch, or the commit when nothing was checked out). */
  base?: string;
}

export interface CreateCopyRequest {
  isolation: Exclude<Isolation, "in-place">;
  /** Folder the copy goes into. It does not exist yet. */
  path: string;
  /** For `new`: the line to create. For `existing`: the line to check out. */
  line: string;
  /** For `new`: the line to start from. */
  base?: string;
}

/** Bounds on one file's diff. A file over either one gets the note `too_large` instead of its lines. */
export interface DiffLimits {
  maxLines: number;
  maxBytes: number;
}

/** Reading a workspace's changes (R8.1, R8.2). Scopes and records are in neutral words (ADR 0005). */
export interface ChangeOps {
  /** The scopes this provider can show. */
  scopes: readonly ChangeScopeKind[];
  /** The line most work starts from, for workspaces without a recorded base (Git: the remote's default branch). */
  defaultBase(project: Project): Promise<string | undefined>;
  /** The current record of the working copy, or undefined when it has none yet. */
  head(location: WorkspaceLocation): Promise<string | undefined>;
  /** Records on the line since `base`, newest first, at most `limit`. Without a base: the last `limit`. */
  records(
    location: WorkspaceLocation,
    base: string | undefined,
    limit: number,
  ): Promise<ChangeRecord[]>;
  /** Changed files in a scope, at most `limit` (`truncated` says there were more). */
  files(
    location: WorkspaceLocation,
    scope: ChangeScope,
    limit: number,
  ): Promise<{ files: ChangedFile[]; truncated: boolean }>;
  /** One file's diff in a scope; `file` comes from `files` for the same scope. */
  diff(
    location: WorkspaceLocation,
    scope: ChangeScope,
    file: ChangedFile,
    limits: DiffLimits,
  ): Promise<FileDiff>;
}

/** Sending a line to where others see it (Git: push). Never rewrites what is there (R9.3). */
export interface PublishOps {
  /** Publishes the line and remembers where it went. Throws ApiError 409 when it cannot, with the reason. */
  push(location: WorkspaceLocation, line: string): Promise<{ remote: string }>;
}

/**
 * A version control provider (ADR 0005). Nothing outside a provider branches on `kind`. Optional capabilities are
 * detected by presence.
 */
export interface VcsProvider {
  kind: string;
  /** Higher runs first. The folder provider is the fallback at 0. */
  priority: number;
  detect(path: string): Promise<boolean>;
  /** The project root that contains `path`, as an absolute real path. */
  root(path: string): Promise<string>;
  isolationModes: readonly Isolation[];
  createCopy(project: Project, request: CreateCopyRequest): Promise<WorkspaceLocation>;
  /** Removes a copy made by `createCopy`. Throws an ApiError 409 if it holds work that would be lost, unless
   * `force`. */
  removeCopy(
    project: Project,
    location: WorkspaceLocation,
    options: { force: boolean },
  ): Promise<void>;
  lines?: {
    list(project: Project): Promise<{ lines: string[]; current?: string }>;
  };
  changes?: ChangeOps;
  publish?: PublishOps;
}

/** A project trait that a module detects and acts on, such as Unity. */
export interface TraitDefinition {
  id: string;
  /** Returns the trait if the project has it. */
  detect(projectPath: string): Promise<ProjectTrait | undefined>;
  /** Gitignored files and folders a new copy needs (R2.6), as patterns relative to the project root. */
  worktreeCopy?: readonly string[];
  /** Warnings to show before copying from the main copy, for example "Unity has it open". */
  copyWarnings?(projectPath: string): Promise<string[]>;
}

export interface ResolvedProjectConfig extends ProjectConfigView {
  /** Warnings from traits about copying from the main copy now. */
  copyWarnings(): Promise<string[]>;
}

/** A config file parsed as TOML and checked for model keys (R17.3). Each module checks its own sections. */
export interface RawConfigFile {
  path: string;
  data: Record<string, unknown>;
}

export interface RawConfigFiles {
  /** `<project>/.pi-spore/config.toml` */
  project?: RawConfigFile;
  /** `<project>/.pi-spore/config.local.toml`, which wins over the project file. */
  local?: RawConfigFile;
}

/** Throws an ApiError to stop a project from being removed. */
export type RemovalGuard = (project: Project) => void;

export interface Projects {
  registerVcs(provider: VcsProvider): void;
  registerTrait(trait: TraitDefinition): void;
  addRemovalGuard(guard: RemovalGuard): void;
  /** Throws ApiError 404 if there is no such project. */
  get(id: string): Promise<Project>;
  list(): Promise<Project[]>;
  vcsFor(project: Project): VcsProvider;
  config(project: Project): Promise<ResolvedProjectConfig>;
  /** Reads the config files of a project. Bad TOML or a model key answers 422 `bad_project_config`. */
  configFiles(project: Project): Promise<RawConfigFiles>;
  /** Checks a section against its schema; a mismatch answers 422 `bad_project_config`. */
  checkConfigSection<const S extends TSchema>(schema: S, value: unknown, what: string): Static<S>;
}

export const ProjectsKey = defineInterface<Projects>("projects", "projects");
