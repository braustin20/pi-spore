// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { ActionRun, Workspace } from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { actionsWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = { id: "W1", state: "active" } as Workspace;

const run = (status: ActionRun["status"]): ActionRun => ({
  id: "R1",
  workspaceId: "W1",
  action: "dev",
  trigger: "user",
  status,
  logPath: "/tmp/R1.log",
  createdAt: 0,
});

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

async function renderLog(status: ActionRun["status"], text: string) {
  let panel: ComponentType<{ workspace: Workspace }> | undefined;
  actionsWeb.setup({
    use: () => ({ addPanel: (added: { component: typeof panel }) => (panel = added.component) }),
  } as unknown as WebHost);
  if (!panel) throw new Error("the actions module did not add its panel");
  const Panel = panel;
  const shown = run(status);
  const api = {
    get: async (path: string) => {
      if (path === "actions/workspaces/W1") {
        return {
          actions: [{ name: "dev", run: "dev", shell: false, exclusive: false, source: "default" }],
        };
      }
      if (path === "actions/workspaces/W1/runs") return { runs: [shown] };
      if (path === "actions/runs/R1/log") {
        return { run: shown, text, start: 0, end: text.length, size: text.length };
      }
      // The follow loop of a running run: wait forever, like a long poll with no news.
      if (path.startsWith("actions/runs/R1/log?from=")) return new Promise(() => {});
      throw new Error(`unexpected GET ${path}`);
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <Panel workspace={workspace} />
      </ApiContext>,
    );
  });
  const root = container;
  await act(async () => {
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Log")?.click();
  });
  const link = (label: string) =>
    [...root.querySelectorAll("a")].find((anchor) => anchor.textContent === label);
  return { link, links: [...root.querySelectorAll("a")], text: root.textContent ?? "" };
}

describe("loopback URLs in a run's log", () => {
  it("links the URL and offers Open for a running run", async () => {
    const { link } = await renderLog("running", "pi-spore dev server: http://127.0.0.1:43211/\n");
    const open = link("Open");
    expect(open?.getAttribute("href")).toBe("http://127.0.0.1:43211/");
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(link("http://127.0.0.1:43211/")?.getAttribute("target")).toBe("_blank");
  });

  it("opens the newest URL", async () => {
    const { link } = await renderLog(
      "running",
      "dev server: http://127.0.0.1:43211/\nrestarted: http://localhost:43212/app\n",
    );
    expect(link("Open")?.getAttribute("href")).toBe("http://localhost:43212/app");
  });

  it("offers no Open once the run has ended, but keeps the link", async () => {
    const { link } = await renderLog("succeeded", "dev server: http://127.0.0.1:43211/\n");
    expect(link("Open")).toBeUndefined();
    expect(link("http://127.0.0.1:43211/")).toBeDefined();
  });

  it("leaves other hosts as plain text", async () => {
    const { links } = await renderLog("running", "see http://example.com:8080/ for docs\n");
    expect(links).toEqual([]);
  });

  it("shows a log with color codes as plain text", async () => {
    const { text } = await renderLog("succeeded", "\x1b[31mred\x1b[39m\n");
    expect(text).toContain("red");
    expect(text).not.toContain("\x1b");
  });
});
