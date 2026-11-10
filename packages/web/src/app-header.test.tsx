// @vitest-environment happy-dom
import { type ApiClient, ApiContext } from "@pi-spore/module-api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function renderApp(): Promise<HTMLElement> {
  const api = { get: () => new Promise(() => {}) } as unknown as ApiClient;
  const div = document.body.appendChild(document.createElement("div"));
  container = div;
  root = createRoot(div);
  await act(async () => {
    root?.render(
      <ApiContext value={api}>
        <App pages={[]} />
      </ApiContext>,
    );
  });
  return div;
}

describe("the app top bar", () => {
  it("hides on a phone while a text field has focus", async () => {
    const app = await renderApp();
    expect(app.querySelector("header")?.hasAttribute("data-hide-while-typing")).toBe(true);
  });

  it("shows the spore logo and the name in the brand link", async () => {
    const app = await renderApp();
    const brand = app.querySelector('header a[href="#/"]');
    const logo = brand?.querySelector("svg");
    expect(logo?.getAttribute("aria-hidden")).toBe("true");
    // The logo: one core and five spores, five arms.
    expect(logo?.querySelectorAll("circle")).toHaveLength(6);
    expect(logo?.querySelectorAll("path")).toHaveLength(5);
    expect(brand?.textContent).toBe("pi-spore");
  });
});
