import { defineInterface } from "@pi-spore/module-api";
import type { ArtifactInfo } from "@pi-spore/shared";

/** The folder an artifact lives in: one workspace's, or one project's (ADR 0070). */
export type ArtifactOwner = { scope: "workspace"; id: string } | { scope: "project"; id: string };

/** Artifacts for other modules. Paths are relative with `/` separators; a bad one throws a 400 `bad_path`. */
export interface Artifacts {
  /** Regular files of the owner's folder, by path. Symlinks are skipped. Throws 404 for an unknown workspace or project. */
  list(owner: ArtifactOwner): Promise<ArtifactInfo[]>;
  read(owner: ArtifactOwner, path: string): Promise<{ info: ArtifactInfo; bytes: Buffer }>;
  /** Creates or replaces the file. `agentId` names the agent writer; omit it for the user. */
  write(
    owner: ArtifactOwner,
    path: string,
    content: string,
    agentId?: string,
  ): Promise<ArtifactInfo>;
  /** Copies a workspace artifact to the same path in its project; the original stays. 409 `artifact_exists` if the project has that path. */
  promote(workspaceId: string, path: string, agentId?: string): Promise<ArtifactInfo>;
}

export const ArtifactsKey = defineInterface<Artifacts>("artifacts", "artifacts");
