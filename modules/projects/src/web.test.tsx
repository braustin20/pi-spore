// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { projectsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = (id: string, name: string): Workspace => ({
  id,
  projectId: "P1",
  name,
  slug: id,
  isolation: "new",
  path: `/w/${id}`,
  state: "active",
  createdAt: 0,
  updatedAt: 0,
});

const view = (value: string) => ({
  settings: [{ key: "worktree.branch_prefix", value, source: "workspace" }],
});

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

describe("the workspace settings panel", () => {
  it("ignores a slow answer for a workspace that is no longer picked", async () => {
    let page: ComponentType | undefined;
    projectsWeb.setup({
      addPage: (added: { path: string; component: ComponentType }) => {
        if (added.path === "/settings") page = added.component;
      },
    } as unknown as WebHost);
    if (!page) throw new Error("the projects module did not add the settings page");
    const Page = page;
    const answers = new Map<string, (body: unknown) => void>();
    const api = {
      get: (path: string) => {
        if (path === "projects/settings") return Promise.resolve({ settings: [] });
        if (path === "workspaces?state=active") {
          return Promise.resolve({ workspaces: [workspace("W1", "One"), workspace("W2", "Two")] });
        }
        return new Promise((resolve) => answers.set(path, resolve));
      },
    } as unknown as ApiClient;
    container = document.body.appendChild(document.createElement("div"));
    const root = container;
    await act(async () => {
      createRoot(root).render(
        <ApiContext value={api}>
          <Page />
        </ApiContext>,
      );
    });
    const select = root.querySelector("select[aria-label='Workspace']") as HTMLSelectElement;
    const pick = async (id: string) => {
      await act(async () => {
        select.value = id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await pick("W1");
    await pick("W2");
    await act(async () => answers.get("workspaces/W2/settings")?.(view("two-")));
    await act(async () => answers.get("workspaces/W1/settings")?.(view("one-")));
    expect(root.textContent).toContain("two-");
    expect(root.textContent).not.toContain("one-");

    await pick("");
    expect(root.textContent).not.toContain("two-");
  });
});
