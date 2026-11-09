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

const status = (mergeWhenReady: boolean): PrStatus => ({
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
  mergeWhenReady,
  watch: { state: "off", tries: 0, maxTries: 3 },
  tries: [],
  local: { headId, uncommitted: 0 },
});

type ApprovalProps = {
  approval: { subject: unknown };
  busy: boolean;
  approve: (subject?: unknown) => void;
  decline: (note?: string) => void;
};

const NoNote = () => null;

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  vi.restoreAllMocks();
});

function setup() {
  let tab: ComponentType<{ workspace: Workspace }> | undefined;
  let approvalView: { kind: string; view: ComponentType<ApprovalProps> } | undefined;
  const host = {
    use: () => ({
      addTab: (added: { component: typeof tab }) => (tab = added.component),
      addPanel: () => {},
      addApprovalView: (kind: string, view: ComponentType<ApprovalProps>) =>
        (approvalView = { kind, view }),
      DeclineNote: NoNote,
    }),
  };
  githubPrWeb.setup(host as unknown as WebHost);
  if (!tab) throw new Error("the github-pr module did not add its tab");
  return { Tab: tab, approvalView };
}

const button = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === name);

async function mount(element: React.ReactElement, api: Partial<ApiClient> = {}) {
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api as ApiClient}>
        <TooltipProvider>{element}</TooltipProvider>
      </ApiContext>,
    );
  });
  return container;
}

describe("the workspace-pr approval view", () => {
  const subject = { workspaceId: "W1", title: "Add thing", body: "Why", base: "main" };

  async function renderApproval(busy = false) {
    const { approvalView } = setup();
    if (!approvalView) throw new Error("the github-pr module did not add an approval view");
    expect(approvalView.kind).toBe("workspace-pr");
    const View = approvalView.view;
    const approve = vi.fn();
    const decline = vi.fn();
    const root = await mount(
      <View approval={{ subject }} busy={busy} approve={approve} decline={decline} />,
    );
    return { root, approve, decline };
  }

  it("Open PR approves without mergeWhenReady", async () => {
    const { root, approve } = await renderApproval();
    await act(async () => button(root, "Open PR")?.click());
    expect(approve).toHaveBeenCalledWith(subject);
    expect(approve.mock.calls[0]?.[0]).not.toHaveProperty("mergeWhenReady");
  });

  it("Open and merge when checks pass approves with mergeWhenReady and the edited title", async () => {
    const { root, approve } = await renderApproval();
    const input = root.querySelector("input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "  New title  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(root, "Open and merge when checks pass")?.click());
    expect(approve).toHaveBeenCalledWith({ ...subject, title: "New title", mergeWhenReady: true });
  });

  it("Decline declines", async () => {
    const { root, approve, decline } = await renderApproval();
    await act(async () => button(root, "Decline")?.click());
    expect(decline).toHaveBeenCalledWith(undefined);
    expect(approve).not.toHaveBeenCalled();
  });

  it("turns both approve buttons off while busy", async () => {
    const { root } = await renderApproval(true);
    expect(button(root, "Open PR")?.disabled).toBe(true);
    expect(button(root, "Open and merge when checks pass")?.disabled).toBe(true);
  });
});

describe("the PR tab merge-when-ready line", () => {
  async function renderTab(shown: PrStatus) {
    const { Tab } = setup();
    const send = vi.fn(async () => status(false));
    const root = await mount(<Tab workspace={workspace} />, {
      get: async () => shown,
      send,
      subscribe: () => () => {},
    } as unknown as ApiClient);
    return { root, send };
  }

  it("shows the line and Turn off, and Turn off sends DELETE with no confirm", async () => {
    const { root, send } = await renderTab(status(true));
    expect(root.textContent).toContain("Will merge when checks pass");
    await act(async () => button(root, "Turn off")?.click());
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(send).toHaveBeenCalledWith(
      "DELETE",
      "github-pr/workspaces/W1/merge-when-ready",
      undefined,
    );
    expect(root.textContent).not.toContain("Will merge when checks pass");
  });

  it("shows neither when mergeWhenReady is false", async () => {
    const { root } = await renderTab(status(false));
    expect(root.textContent).not.toContain("Will merge when checks pass");
    expect(button(root, "Turn off")).toBeUndefined();
  });
});
