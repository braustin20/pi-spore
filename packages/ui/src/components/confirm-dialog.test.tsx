// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { type Confirm, useConfirm } from "./confirm-dialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  document.body.innerHTML = "";
});

function Host({ onReady }: { onReady: (confirm: Confirm) => void }) {
  const { confirm, dialog } = useConfirm();
  onReady(confirm);
  return <>{dialog}</>;
}

function mount() {
  let confirm: Confirm | undefined;
  container = document.body.appendChild(document.createElement("div"));
  act(() => {
    createRoot(container as HTMLElement).render(
      <Host
        onReady={(value) => {
          confirm = value;
        }}
      />,
    );
  });
  if (!confirm) throw new Error("the hook did not render");
  return confirm;
}

const buttons = () => [
  ...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button"),
];
const button = (label: string) => buttons().find((each) => each.textContent === label);

describe("useConfirm", () => {
  it("shows the pending action's text and resolves true on the confirm button", async () => {
    const confirm = mount();
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = confirm({ title: "Archive", message: "Archive Work a?", confirmLabel: "Archive" });
    });
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Archive Work a?");
    await act(async () => button("Archive")?.click());
    await expect(answer).resolves.toBe(true);
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });

  it("resolves false on Escape", async () => {
    const confirm = mount();
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = confirm({ message: "Go on?" });
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await expect(answer).resolves.toBe(false);
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });

  it("resolves false on Cancel, and puts focus on Cancel first", async () => {
    const confirm = mount();
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = confirm({ message: "Delete it?", tone: "danger", confirmLabel: "Delete" });
    });
    expect(document.activeElement).toBe(button("Cancel"));
    await act(async () => button("Cancel")?.click());
    await expect(answer).resolves.toBe(false);
  });

  it("resolves an earlier question false when a new one replaces it", async () => {
    const confirm = mount();
    let first: Promise<boolean> | undefined;
    await act(async () => {
      first = confirm({ message: "First?" });
    });
    await act(async () => {
      void confirm({ message: "Second?" });
    });
    await expect(first).resolves.toBe(false);
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Second?");
  });
});
