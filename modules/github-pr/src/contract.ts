import { defineInterface } from "@pi-spore/module-api";
import type { PullRequest } from "@pi-spore/shared";

/** Pull requests for other modules, so they open one without HTTP and without running `gh` themselves. */
export interface PullRequests {
  /**
   * Pushes the workspace's line and opens a PR from it to `base`, as `POST /api/github-pr/workspaces/:id/publish`
   * does, with the same errors (409 workspace_not_active, 422 not_supported, 409 pr_exists, 422 gh_failed). It never
   * merges and never turns on auto-merge (ADR 0130).
   */
  open(
    workspaceId: string,
    request: { title: string; body: string; base: string; draft?: boolean },
  ): Promise<PullRequest>;
}

export const PullRequestsKey = defineInterface<PullRequests>("github-pr", "pull-requests");
