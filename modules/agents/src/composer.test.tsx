// @vitest-environment happy-dom
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function render(busy: boolean) {
  const onSend = vi.fn(async () => {});
  // Wide screen: the split button is the same on a phone, which composer-phone.test.tsx covers.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(
      <TooltipProvider>
        <Composer
          chatId="c1"
          busy={busy}
          disabled={false}
          loadCommands={async () => []}
          imageInput={true}
          onSend={onSend}
          onAbort={() => {}}
        />
      </TooltipProvider>,
    );
  });
  return onSend;
}

/** A button by its accessible name: its aria-label, else its text. */
const button = (name: string) =>
  [...(container?.querySelectorAll("button") ?? [])].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === name,
  );

const click = async (element: HTMLElement | undefined) => {
  if (!element) throw new Error("no button to click");
  await act(async () => element.click());
};

const type = async (value: string) => {
  const box = container?.querySelector<HTMLTextAreaElement>("textarea");
  if (!box) throw new Error("no text box");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** Radix menus open on a primary-button pointerdown, not on click. The menu renders in a portal. */
const openMenu = async (trigger: HTMLElement | undefined) => {
  if (!trigger) throw new Error("no menu trigger");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  const menu = document.querySelector<HTMLElement>("[role=menu]");
  if (!menu) throw new Error("the menu did not open");
  return menu;
};

const item = (menu: HTMLElement, label: string) => {
  const found = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")].find((element) =>
    element.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no menu item ${label}`);
  return found;
};

describe("the composer's send button", () => {
  it("sends a steer while the agent works, with no select for the choice", async () => {
    const onSend = await render(true);
    expect(container?.querySelector('[aria-label="When a message sent now goes in"]')).toBeNull();
    expect(button("Steer")).toBeDefined();
    await type("Do it");
    await click(button("Steer"));
    expect(onSend).toHaveBeenCalledWith("Do it", "steer", []);
  });

  it("picks Follow up from the arrow menu and sends that way", async () => {
    const onSend = await render(true);
    await type("Later");
    const arrow = button("Choose when the message goes in");
    // The arrow is never disabled, so the mode can be picked before there is any text.
    expect(arrow?.disabled).toBe(false);
    const menu = await openMenu(arrow);
    // The current choice carries a check; the other keeps an empty box so the text lines up.
    expect(item(menu, "Steer").querySelector("svg[aria-hidden]")).not.toBeNull();
    const other = item(menu, "Follow up");
    expect(other.querySelector("svg")).toBeNull();
    expect(other.querySelector("span")?.classList).toContain("size-3.5");
    await act(async () => other.click());
    // A pick only sets the mode; it never sends.
    expect(onSend).not.toHaveBeenCalled();
    expect(button("Follow up")).toBeDefined();
    expect(button("Steer")).toBeUndefined();
    await click(button("Follow up"));
    expect(onSend).toHaveBeenCalledWith("Later", "followUp", []);
  });

  it("is a plain Send with no menu while the agent is idle", async () => {
    await render(false);
    expect(button("Send")).toBeDefined();
    expect(button("Choose when the message goes in")).toBeUndefined();
    expect(container?.querySelector('[aria-label="When a message sent now goes in"]')).toBeNull();
  });
});
