import { defineInterface } from "@pi-spore/module-api";
import type { EditorLease, ProjectEditors } from "@pi-spore/shared";

/**
 * The editor lease of Unity projects (R10.4, ADR 0011), for the UI now and for batch-mode gates and agents later.
 * One editor per project: the main checkout and all its workspaces share it.
 */
export interface UnityEditors {
  /** Editors open on the project and who holds its lease. Reconciles the lease with what is running. */
  editors(projectId: string): Promise<ProjectEditors>;
  /**
   * Opens the editor on a workspace's folder and gives the lease to `owner`. Throws ApiError 409 `editor_open` if an
   * editor has another folder of the project open; that one must be closed first.
   */
  open(
    workspaceId: string,
    owner: EditorLease["owner"],
  ): Promise<{ lease: EditorLease; alreadyOpen: boolean }>;
  /**
   * Closes the editor on `path`. `unity close` does not save, so callers must have the user's explicit yes for an
   * editor the user owns (R10.5).
   */
  close(projectId: string, path: string): Promise<void>;
}

export const UnityEditorsKey = defineInterface<UnityEditors>("unity", "editors");
