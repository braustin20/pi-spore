// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { PrStatus, Workspace } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubPrWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const headId = "a".repeat(40);
const workspace = { id: "W1" } as Workspace;

const status = (mergeBlocked?: string): PrStatus => ({
  workspaceId: "W1",
  publishable: true,
  defaults: { title: "Work", body: "" },
  pr: {
    number: 12,
    url: "https://github.com/owner/repo/pull/12",
    title: "Work",
    state: "open",
    draft: false,
    line: "spore/work",
    base: "main",
    headId,
    review: "none",
    mergeable: "mergeable",
    checks: [],
  },
  ...(mergeBlocked ? { mergeBlocked } : {}),
  watch: { state: "off", tries: 0, maxTries: 3 },
  tries: [],
  local: { headId, uncommitted: 0 },
});

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  vi.restoreAllMocks();
});

async function render(shown: PrStatus) {
  let tab: ComponentType<{ workspace: Workspace }> | undefined;
  const view = {
    addTab: (added: { component: typeof tab }) => (tab = added.component),
    addPanel: () => {},
  };
  githubPrWeb.setup({ use: () => view } as unknown as WebHost);
  if (!tab) throw new Error("the github-pr module did not add its tab");
  const Tab = tab;
  const send = vi.fn(async () => shown);
  const api = {
    get: async () => shown,
    send,
    subscribe: () => () => {},
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <Tab workspace={workspace} />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Merge",
  );
  if (!button) throw new Error("the Merge button did not render");
  return { button, send };
}

describe("the Merge button", () => {
  it("is disabled while the PR cannot merge", async () => {
    const { button } = await render(status("Checks are still running: test"));
    expect(button.disabled).toBe(true);
  });

  it("asks first, sends nothing on no, and posts the head the user saw on yes", async () => {
    const { button, send } = await render(status());
    expect(button.disabled).toBe(false);

    // happy-dom has no confirm dialog.
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    await act(async () => button.click());
    expect(confirm).toHaveBeenCalledWith("Merge #12 into main with a merge commit?");
    expect(send).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => button.click());
    expect(send).toHaveBeenCalledWith("POST", "github-pr/workspaces/W1/merge", {
      confirm: true,
      headId,
    });
  });
});
