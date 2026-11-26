// @vitest-environment happy-dom
import { type ApiClient, ApiContext } from "@pi-spore/module-api";
import type { HermesStatus } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { HermesSection } from "../src/web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(answers: HermesStatus[]) {
  const gets: string[] = [];
  const api = {
    get: async (path: string) => {
      gets.push(path);
      return answers[Math.min(gets.length, answers.length) - 1];
    },
  } as unknown as ApiClient;
  const root = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <HermesSection />
      </ApiContext>,
    );
  });
  return { root, gets };
}

describe("Hermes row on the Settings page", () => {
  it("shows the status from /api/hermes/status, and reloads it", async () => {
    const { root, gets } = await render([
      { state: "disabled" },
      { state: "incompatible", detail: "Hermes 0.24.0 is not tested", checkedAt: 1 },
    ]);
    expect(root.textContent).toContain("disabled");
    expect(root.textContent).toContain("hermes.enabled");
    const reload = [...root.querySelectorAll("button")].find((b) => b.textContent === "Reload");
    await act(async () => reload?.click());
    expect(gets).toEqual(["hermes/status", "hermes/status"]);
    expect(root.textContent).toContain("incompatible");
    expect(root.textContent).toContain("Hermes 0.24.0 is not tested");
  });

  it("shows a ready Hermes with its version and profile", async () => {
    const { root } = await render([
      {
        state: "ready",
        version: "0.23.3",
        url: "http://hermes-docker:8642",
        profile: "pi-spore",
        checkedAt: 1,
      },
    ]);
    expect(root.textContent).toContain("ready");
    expect(root.textContent).toContain(
      "Hermes 0.23.3 at http://hermes-docker:8642, profile pi-spore.",
    );
  });
});
