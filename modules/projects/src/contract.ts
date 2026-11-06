import { defineInterface } from "@pi-spore/module-api";
import type { Isolation, Project, ProjectConfigView, ProjectTrait } from "@pi-spore/shared";

/** Where a workspace's copy lives, as a provider made it. */
export interface WorkspaceLocation {
  path: string;
  /** Git: the branch. */
  line?: string;
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
}

export const ProjectsKey = defineInterface<Projects>("projects", "projects");
