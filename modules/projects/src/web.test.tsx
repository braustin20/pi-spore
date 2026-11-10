// @vitest-environment happy-dom
import { type ApiClient, ApiContext, ApiRequestError, type WebHost } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

type Entry = { key: string; value: unknown; source: string };

function pageAt(path: string): ComponentType<{ params: Record<string, string> }> {
  let page: ComponentType<{ params: Record<string, string> }> | undefined;
  projectsWeb.setup({
    addPage: (added: {
      path: string;
      component: ComponentType<{ params: Record<string, string> }>;
    }) => {
      if (added.path === path) page = added.component;
    },
  } as unknown as WebHost);
  if (!page) throw new Error(`the projects module did not add ${path}`);
  return page;
}

async function render(
  path: string,
  params: Record<string, string>,
  get: (path: string) => unknown,
  send: (method: string, path: string, body: unknown) => Promise<unknown>,
) {
  const Page = pageAt(path);
  const api = {
    get: (asked: string) => Promise.resolve(get(asked)),
    send,
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  const root = container;
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <Page params={params} />
      </ApiContext>,
    );
  });
  return root;
}

function rowOf(root: HTMLElement, text: string): HTMLElement {
  const row = [...root.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(text));
  if (!row) throw new Error(`no row with ${text}`);
  return row;
}

async function click(within: HTMLElement, label: string) {
  const button = [...within.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
}

async function type(within: HTMLElement, text: string) {
  const field = within.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the global settings panel", () => {
  const start = (entries: Entry[]) => {
    const state = { entries };
    const get = (path: string) =>
      path === "projects/settings" ? { settings: state.entries } : { workspaces: [] };
    return { state, get };
  };

  it("saves a number, loads again, and says to restart", async () => {
    const { state, get } = start([{ key: "agents.maxLive", value: 8, source: "default" }]);
    const send = vi.fn(async () => {
      state.entries = [{ key: "agents.maxLive", value: 4, source: "global" }];
      return { setting: state.entries[0] };
    });
    const root = await render("/settings", {}, get, send);
    await click(rowOf(root, "agents.maxLive"), "Edit");
    await type(rowOf(root, "agents.maxLive"), "4");
    await click(rowOf(root, "agents.maxLive"), "Save");
    expect(send).toHaveBeenCalledWith("PUT", "projects/settings", {
      key: "agents.maxLive",
      value: 4,
    });
    const row = rowOf(root, "agents.maxLive");
    expect(row.textContent).toContain("4");
    expect(row.textContent).not.toContain("8");
    expect(row.textContent).toContain("global");
    expect(row.textContent).toContain("Restart pi-spore to apply");
  });

  it("shows the server's message and keeps the old value when a save fails", async () => {
    const { get } = start([{ key: "agents.maxLive", value: 8, source: "default" }]);
    const send = vi.fn(async () => {
      throw new ApiRequestError(422, "bad_settings", "agents.maxLive must be >= 1");
    });
    const root = await render("/settings", {}, get, send);
    await click(rowOf(root, "agents.maxLive"), "Edit");
    await type(rowOf(root, "agents.maxLive"), "0");
    await click(rowOf(root, "agents.maxLive"), "Save");
    const row = rowOf(root, "agents.maxLive");
    expect(row.textContent).toContain("agents.maxLive must be >= 1");
    expect(row.querySelector("td code")?.textContent).toBe("8");
    expect(row.textContent).toContain("default");
    expect(row.textContent).not.toContain("Restart pi-spore to apply");
    expect((row.querySelector("input") as HTMLInputElement).value).toBe("0");
    await type(row, "3");
    expect((row.querySelector("input") as HTMLInputElement).value).toBe("3");
  });

  it("keeps the row busy until the new value has loaded", async () => {
    let started = false;
    const loads: ((body: unknown) => void)[] = [];
    const get = (path: string) => {
      if (path !== "projects/settings") return { workspaces: [] };
      if (!started) {
        started = true;
        return { settings: [{ key: "agents.maxLive", value: 8, source: "default" }] };
      }
      return new Promise((resolve) => loads.push(resolve));
    };
    const send = vi.fn(async () => ({}));
    const root = await render("/settings", {}, get, send);
    await click(rowOf(root, "agents.maxLive"), "Edit");
    await type(rowOf(root, "agents.maxLive"), "4");
    await click(rowOf(root, "agents.maxLive"), "Save");
    expect(send).toHaveBeenCalledTimes(1);
    const buttons = () =>
      [...rowOf(root, "agents.maxLive").querySelectorAll("button")].map((b) => [
        b.textContent,
        b.disabled,
      ]);
    expect(buttons()).toEqual([
      ["Save", true],
      ["Cancel", true],
    ]);
    await act(async () =>
      loads[0]?.({ settings: [{ key: "agents.maxLive", value: 4, source: "global" }] }),
    );
    expect(buttons()).toEqual([
      ["Edit", false],
      ["Reset", false],
    ]);
    expect(rowOf(root, "agents.maxLive").textContent).toContain("4");
  });

  it("keeps the draft and blocks stale edits when the load after a save fails", async () => {
    let started = false;
    const loads: { resolve: (body: unknown) => void; reject: (error: Error) => void }[] = [];
    const get = (path: string) => {
      if (path !== "projects/settings") return { workspaces: [] };
      if (!started) {
        started = true;
        return { settings: [{ key: "agents.maxLive", value: 8, source: "default" }] };
      }
      return new Promise((resolve, reject) => loads.push({ resolve, reject }));
    };
    const send = vi.fn(async () => ({}));
    const root = await render("/settings", {}, get, send);
    const row = () => rowOf(root, "agents.maxLive");
    const buttons = () =>
      [...row().querySelectorAll("button")].map((b) => [b.textContent, b.disabled]);
    await click(row(), "Edit");
    await type(row(), "4");
    await click(row(), "Save");
    await act(async () => loads[0]?.reject(new Error("server is down")));
    expect(row().textContent).toContain("server is down");
    expect((row().querySelector("input") as HTMLInputElement).value).toBe("4");
    expect(buttons()).toEqual([
      ["Save", false],
      ["Cancel", false],
    ]);
    await click(row(), "Cancel");
    expect(buttons()).toEqual([
      ["Edit", true],
      ["Reset", true],
    ]);
  });

  it("shows the newest load when two loads end out of order", async () => {
    const entries = (days: number, keep: number) => ({
      settings: [
        { key: "retention.days", value: days, source: "global" },
        { key: "agents.maxLive", value: keep, source: "global" },
      ],
    });
    let started = false;
    const loads: ((body: unknown) => void)[] = [];
    const get = (path: string) => {
      if (path !== "projects/settings") return { workspaces: [] };
      if (!started) {
        started = true;
        return entries(5, 8);
      }
      return new Promise((resolve) => loads.push(resolve));
    };
    const send = vi.fn(async () => ({}));
    const root = await render("/settings", {}, get, send);
    await click(rowOf(root, "retention.days"), "Reset");
    await click(rowOf(root, "agents.maxLive"), "Reset");
    expect(loads).toHaveLength(2);
    await act(async () => loads[1]?.(entries(30, 2)));
    await act(async () => loads[0]?.(entries(30, 8)));
    expect(rowOf(root, "retention.days").textContent).toContain("30");
    expect(rowOf(root, "agents.maxLive").textContent).toContain("2");
    expect(rowOf(root, "agents.maxLive").textContent).not.toContain("8");
  });

  it("resets a key and shows the value and source from the next load", async () => {
    const { state, get } = start([{ key: "retention.days", value: 5, source: "global" }]);
    const send = vi.fn(async () => {
      state.entries = [{ key: "retention.days", value: 30, source: "default" }];
      return { setting: state.entries[0] };
    });
    const root = await render("/settings", {}, get, send);
    await click(rowOf(root, "retention.days"), "Reset");
    expect(send).toHaveBeenCalledWith("PUT", "projects/settings", {
      key: "retention.days",
      unset: true,
    });
    const row = rowOf(root, "retention.days");
    expect(row.textContent).toContain("30");
    expect(row.textContent).toContain("default");
    expect(row.textContent).not.toContain("Restart pi-spore to apply");
  });
});

describe("the project settings panel", () => {
  it("saves to the project's local file and needs no restart", async () => {
    const config = {
      worktreeCopy: { value: ["Library"], source: "detected" },
      branchPrefix: { value: "spore", source: "default" },
    };
    const get = (path: string) => {
      if (path === "projects/P1") {
        return {
          project: {
            id: "P1",
            name: "Game",
            slug: "game",
            path: "/p",
            vcs: "git",
            traits: [],
            createdAt: 0,
          },
        };
      }
      return { config, warnings: [] };
    };
    const send = vi.fn(async () => {
      config.branchPrefix = { value: "me", source: "local override" };
      return {};
    });
    const root = await render("/projects/:id", { id: "P1" }, get, send);
    await click(rowOf(root, "Branch prefix"), "Edit");
    await type(rowOf(root, "Branch prefix"), "me");
    await click(rowOf(root, "Branch prefix"), "Save");
    expect(send).toHaveBeenCalledWith("PUT", "projects/P1/settings", {
      key: "worktree.branch_prefix",
      value: "me",
    });
    const row = rowOf(root, "Branch prefix");
    expect(row.textContent).toContain("me");
    expect(row.textContent).toContain("local override");
    expect(row.textContent).not.toContain("Restart pi-spore to apply");
  });
});
