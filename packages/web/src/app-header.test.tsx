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

describe("the app top bar", () => {
  it("hides on a phone while a text field has focus", async () => {
    const api = { get: () => new Promise(() => {}) } as unknown as ApiClient;
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ApiContext value={api}>
          <App pages={[]} />
        </ApiContext>,
      );
    });
    expect(container.querySelector("header")?.hasAttribute("data-hide-while-typing")).toBe(true);
  });
});
