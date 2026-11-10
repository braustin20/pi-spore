// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { CalibrationResponse, RoutingDecision, TokenUseRow } from "@pi-spore/shared";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { usageWeb } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calibrationBody = (over: Partial<CalibrationResponse>): CalibrationResponse => ({
  threshold: 0.7,
  heavyThreshold: 0.8,
  explore: 0,
  minSample: 5,
  decisions: 10,
  outcomes: 8,
  buckets: {
    bounded: [],
    explicit: [],
    visual: [],
    straightforward: [],
    foundational: [],
    design: [],
  },
  bars: [],
  rungs: [],
  skipped: 0,
  ...over,
});

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  document.body.innerHTML = "";
});

async function renderPage(
  over: Partial<CalibrationResponse>,
  lists: { tokens?: TokenUseRow[]; decisions?: RoutingDecision[] } = {},
) {
  let page: ComponentType | undefined;
  usageWeb.setup({
    addPage: (added: { component: ComponentType }) => {
      page = added.component;
    },
  } as unknown as WebHost);
  if (!page) throw new Error("the usage module did not add its page");
  const Page = page;
  const sent: { method: string; path: string; body: unknown }[] = [];
  const api = {
    get: async (path: string) => {
      if (path === "usage/plans") {
        return {
          plans: [],
          warnings: [],
          thresholds: { weekly: 0.9, fiveHour: 0.9 },
          maxAgeMinutes: 10,
          errors: [],
        };
      }
      if (path === "usage/tokens") {
        return { rows: lists.tokens ?? [], sessions: 0, skippedLines: 0 };
      }
      if (path === "usage/routing") return { decisions: lists.decisions ?? [], skipped: 0 };
      if (path === "usage/calibration") return calibrationBody(over);
      throw new Error(`unexpected GET ${path}`);
    },
    send: async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      return {};
    },
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(
      <ApiContext value={api}>
        <Page />
      </ApiContext>,
    );
  });
  const root = container;
  const pageButton = (label: string) =>
    [...root.querySelectorAll("button")].find((each) => each.textContent === label);
  const dialogButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find(
      (each) => each.textContent === label,
    );
  return { sent, pageButton, dialogButton };
}

describe("calibration buttons", () => {
  it("offers no Apply suggested bar when the suggestion equals the bar or is absent", async () => {
    const same = await renderPage({ suggestedBar: 0.7 });
    expect(same.pageButton("Apply suggested bar")).toBeUndefined();
    container?.remove();
    const absent = await renderPage({});
    expect(absent.pageButton("Apply suggested bar")).toBeUndefined();
  });

  it("sends the suggested bar only after the user confirms", async () => {
    const { sent, pageButton, dialogButton } = await renderPage({
      suggestedBar: 0.4,
      threshold: 0.7,
    });
    await act(async () => pageButton("Apply suggested bar")?.click());
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
      "Set router.threshold from 0.7 to 0.4?",
    );
    expect(sent).toEqual([]);
    await act(async () => dialogButton("Apply")?.click());
    expect(sent).toEqual([{ method: "PATCH", path: "usage/router", body: { threshold: 0.4 } }]);
  });

  it("offers Turn off explore before any decisions exist", async () => {
    const { sent, pageButton, dialogButton } = await renderPage({ decisions: 0, explore: 0.1 });
    expect(container?.textContent).toContain("Explore now: 0.1.");
    await act(async () => pageButton("Turn off explore")?.click());
    await act(async () => dialogButton("Turn off")?.click());
    expect(sent).toEqual([{ method: "PATCH", path: "usage/router", body: { explore: 0 } }]);
  });

  it("sends nothing when the user cancels", async () => {
    const { sent, pageButton, dialogButton } = await renderPage({
      suggestedBar: 0.4,
      threshold: 0.7,
    });
    await act(async () => pageButton("Apply suggested bar")?.click());
    await act(async () => dialogButton("Cancel")?.click());
    expect(sent).toEqual([]);
  });

  it("turns explore off after a confirm, and hides the button when explore is 0", async () => {
    const { sent, pageButton, dialogButton } = await renderPage({ explore: 0.1 });
    await act(async () => pageButton("Turn off explore")?.click());
    expect(sent).toEqual([]);
    await act(async () => dialogButton("Turn off")?.click());
    expect(sent).toEqual([{ method: "PATCH", path: "usage/router", body: { explore: 0 } }]);
    container?.remove();
    document.body.innerHTML = "";
    const off = await renderPage({ explore: 0 });
    expect(off.pageButton("Turn off explore")).toBeUndefined();
  });
});

const decision = (index: number): RoutingDecision => ({
  at: 1_000_000 + index,
  kind: "initial",
  route: "local",
  model: `model-${index + 1}`,
  reasons: [],
  sessionId: `s${index}`,
});

const tokenRow = (index: number, role: "worker" | "reviewer"): TokenUseRow => ({
  projectName: "p",
  workspaceId: `w${index}`,
  workspaceName: `ws-${index + 1}`,
  role,
  external: false,
  provider: "local",
  model: `m${index}`,
  local: true,
  requests: 1,
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

const panel = (title: string) => {
  const found = [...(container?.querySelectorAll("section") ?? [])].find((each) =>
    each.textContent?.includes(title),
  );
  if (!found) throw new Error(`no panel ${title}`);
  return found;
};
const bodyRows = (section: Element) => [...section.querySelectorAll("tbody tr")];
const panelButton = (section: Element, label: string) => {
  const found = [...section.querySelectorAll("button")].find((each) => each.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
};

describe("table pages", () => {
  it("pages 25 routing decisions 10 at a time", async () => {
    await renderPage({}, { decisions: Array.from({ length: 25 }, (_, index) => decision(index)) });
    const routing = panel("Routing decisions (spore/auto)");
    expect(bodyRows(routing)).toHaveLength(10);
    expect(routing.textContent).toContain("Rows 1 to 10 of 25");
    expect(routing.textContent).toContain("model-1");
    expect(panelButton(routing, "Previous").disabled).toBe(true);
    expect(panelButton(routing, "Next").disabled).toBe(false);
    await act(async () => panelButton(routing, "Next").click());
    expect(routing.textContent).toContain("Rows 11 to 20 of 25");
    expect(bodyRows(routing)[0]?.textContent).toContain("model-11");
    expect(bodyRows(routing)).toHaveLength(10);
    await act(async () => panelButton(routing, "Next").click());
    expect(routing.textContent).toContain("Rows 21 to 25 of 25");
    expect(bodyRows(routing)).toHaveLength(5);
    expect(panelButton(routing, "Next").disabled).toBe(true);
    await act(async () => panelButton(routing, "Previous").click());
    expect(routing.textContent).toContain("Rows 11 to 20 of 25");
  });

  it("shows the last page that has rows when new data is shorter", async () => {
    const lists = { decisions: Array.from({ length: 25 }, (_, index) => decision(index)) };
    const { pageButton } = await renderPage({}, lists);
    const routing = panel("Routing decisions (spore/auto)");
    await act(async () => panelButton(routing, "Next").click());
    await act(async () => panelButton(routing, "Next").click());
    expect(routing.textContent).toContain("Rows 21 to 25 of 25");
    lists.decisions = lists.decisions.slice(0, 12);
    await act(async () => pageButton("Refresh")?.click());
    const after = panel("Routing decisions (spore/auto)");
    expect(after.textContent).toContain("Rows 11 to 12 of 12");
    expect(bodyRows(after)).toHaveLength(2);
  });

  it("goes back to page 1 when the role filter changes", async () => {
    const tokens = [
      ...Array.from({ length: 15 }, (_, index) => tokenRow(index, "worker")),
      ...Array.from({ length: 15 }, (_, index) => tokenRow(index + 15, "reviewer")),
    ];
    await renderPage({}, { tokens });
    const table = panel("Token use by workspace, role, and model");
    expect(table.textContent).toContain("Rows 1 to 10 of 30");
    await act(async () => panelButton(table, "Next").click());
    expect(table.textContent).toContain("Rows 11 to 20 of 30");
    const roleSelect = table.querySelectorAll("select")[1] as HTMLSelectElement;
    await act(async () => {
      roleSelect.value = "worker";
      roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(table.textContent).toContain("Rows 1 to 10 of 15");
    expect(bodyRows(table)).toHaveLength(10);
  });

  it("sums all rows per role before it pages the sums", async () => {
    const tokens = Array.from({ length: 25 }, (_, index) => ({
      ...tokenRow(index, "worker"),
      model: "same",
    }));
    await renderPage({}, { tokens });
    const table = panel("Token use by workspace, role, and model");
    const groupSelect = table.querySelectorAll("select")[0] as HTMLSelectElement;
    await act(async () => {
      groupSelect.value = "role";
      groupSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(bodyRows(table)).toHaveLength(1);
    expect(bodyRows(table)[0]?.textContent).toContain("25");
    expect(table.textContent).not.toContain("Rows ");
  });

  it("shows no pager for 10 rows or fewer", async () => {
    await renderPage(
      {},
      {
        decisions: Array.from({ length: 10 }, (_, index) => decision(index)),
        tokens: Array.from({ length: 10 }, (_, index) => tokenRow(index, "worker")),
      },
    );
    for (const title of ["Routing decisions (spore/auto)", "Token use by workspace"]) {
      const section = panel(title);
      expect(bodyRows(section)).toHaveLength(10);
      expect(section.textContent).not.toContain("Rows ");
      expect([...section.querySelectorAll("button")].map((each) => each.textContent)).not.toContain(
        "Next",
      );
    }
  });
});
