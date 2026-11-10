// @vitest-environment happy-dom
import { type ApiClient, ApiContext, type WebHost } from "@pi-spore/module-api";
import type { CalibrationResponse } from "@pi-spore/shared";
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

async function renderPage(over: Partial<CalibrationResponse>) {
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
      if (path === "usage/tokens") return { rows: [], sessions: 0, skippedLines: 0 };
      if (path === "usage/routing") return { decisions: [], skipped: 0 };
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
