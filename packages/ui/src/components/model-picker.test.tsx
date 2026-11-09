// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, type PickerModel } from "./model-picker.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  document.body.innerHTML = "";
});

const TIERS = ["light", "medium", "top"];
const MODELS: PickerModel[] = [
  { provider: "anthropic", id: "claude-opus", name: "Opus", tier: "top" },
  { provider: "openai", id: "gpt-mini", name: "Mini", tier: "light" },
  { provider: "anthropic", id: "claude-sonnet", name: "Sonnet", tier: "medium" },
  { provider: "spore", id: "auto", name: "Auto" },
  { provider: "openrouter", id: "opus-clone" },
  { provider: "zai", id: "glm" },
];

function mount(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onChange = vi.fn();
  container = document.body.appendChild(document.createElement("div"));
  act(() => {
    createRoot(container as HTMLElement).render(
      <ModelPicker
        value=""
        label="Pick a model"
        models={MODELS}
        tiers={TIERS}
        onChange={onChange}
        aria-label="Model"
        {...props}
      />,
    );
  });
  return onChange;
}

const trigger = () => document.querySelector<HTMLButtonElement>("button[aria-label=Model]");
const searchBox = () =>
  document.querySelector<HTMLInputElement>("input[aria-label='Search models']");
const section = (name: string) =>
  document.querySelector<HTMLElement>(`section[aria-label='${name}']`);
const itemTexts = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLButtonElement>("button:not([aria-expanded])")].map(
    (each) => each.textContent,
  );
const button = (text: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>("[data-radix-popper-content-wrapper] button"),
  ].find((each) => each.textContent === text);

async function open() {
  await act(async () => trigger()?.click());
}

async function type(text: string) {
  const input = searchBox() as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ModelPicker", () => {
  it("shows only the models that match the search, and Enter picks the first match", async () => {
    const onChange = mount();
    await open();
    expect(document.activeElement).toBe(searchBox());
    await type("opus");
    const popover = document.querySelector("[data-radix-popper-content-wrapper]") as HTMLElement;
    expect(itemTexts(popover)).toEqual(["Opusanthropic", "opus-cloneopenrouter"]);
    expect(section("Suggested")).toBeNull();
    await act(async () => {
      searchBox()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("anthropic/claude-opus");
    expect(searchBox()).toBeNull();
  });

  it("lists the suggested matches first, in tier order, then the rest by name", async () => {
    mount();
    await open();
    await type("o");
    const popover = document.querySelector("[data-radix-popper-content-wrapper]") as HTMLElement;
    expect(itemTexts(popover)).toEqual([
      "Autospore",
      "Miniopenai",
      "Sonnetanthropic",
      "Opusanthropic",
      "opus-cloneopenrouter",
    ]);
  });

  it("lists spore/auto first in Suggested, then the tiered models in tier order", async () => {
    mount();
    await open();
    expect(itemTexts(section("Suggested") as HTMLElement)).toEqual([
      "Autospore",
      "Miniopenai",
      "Sonnetanthropic",
      "Opusanthropic",
    ]);
  });

  it("keeps a provider group closed at first and opens it on click", async () => {
    mount();
    await open();
    const header = button("openrouter (1)") as HTMLButtonElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(button("opus-clone")).toBeUndefined();
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(button("opus-clone")).toBeDefined();
  });

  it("shows the caller's label for a value that is not in the list", () => {
    mount({ value: "gone/old-model", label: "gone/old-model (missing)" });
    expect(trigger()?.textContent).toBe("gone/old-model (missing)");
  });

  it("picks the empty value from the default item", async () => {
    const onChange = mount({ value: "anthropic/claude-opus", defaultLabel: "Role default" });
    await open();
    await act(async () => button("Role default")?.click());
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("shows the tier error as a notice and leaves out Suggested", async () => {
    mount({ tierError: "Tier map is broken" });
    await open();
    const popover = document.querySelector("[data-radix-popper-content-wrapper]") as HTMLElement;
    expect(popover.textContent).toContain("Tier map is broken");
    expect(section("Suggested")).toBeNull();
    expect(button("anthropic (2)")).toBeDefined();
  });
});
