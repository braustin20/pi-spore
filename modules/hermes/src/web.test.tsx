// @vitest-environment happy-dom
import { type ApiClient, ApiContext } from "@pi-spore/module-api";
import type { HermesStatus } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { HermesSection } from "./web.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(answers: HermesStatus[]) {
  const calls: string[] = [];
  const answer = () => answers[Math.min(calls.length, answers.length) - 1];
  const api = {
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return answer();
    },
    send: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return answer();
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
  return { root, calls };
}

describe("Hermes row on the Settings page", () => {
  it("shows the status from /api/hermes/status, and Reload checks again", async () => {
    const { root, calls } = await render([
      { state: "disabled" },
      { state: "incompatible", detail: "Hermes 0.24.0 is not tested", checkedAt: 1 },
    ]);
    expect(root.textContent).toContain("disabled");
    expect(root.textContent).toContain("hermes.enabled");
    const reload = [...root.querySelectorAll("button")].find((b) => b.textContent === "Reload");
    await act(async () => reload?.click());
    expect(calls).toEqual(["GET hermes/status", "POST hermes/refresh"]);
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
