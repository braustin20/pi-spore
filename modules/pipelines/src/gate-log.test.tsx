// @vitest-environment happy-dom
import { GATE_LOG_HEADING } from "@pi-spore/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunMessage } from "./gate-log.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
afterEach(() => container?.remove());

async function render(message: string, failed: boolean) {
  container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    createRoot(container as HTMLElement).render(<RunMessage message={message} failed={failed} />);
  });
  return container;
}

const FAILED = [
  "gate test failed",
  "2 tests failed:",
  "src/a.test.ts > adds > one",
  "src/b.test.ts > subtracts",
  "",
  GATE_LOG_HEADING,
  "RAW LOG LINE",
].join("\n");

describe("RunMessage", () => {
  it("keeps the log of a failed gate in a closed block under the notice", async () => {
    const root = await render(FAILED, true);
    const notice = root.querySelector("[role=alert]");
    const details = root.querySelector("details");
    if (!notice || !details) throw new Error("no notice or no details block");
    expect(notice.textContent).toContain("gate test failed");
    expect(notice.textContent).toContain("src/a.test.ts > adds > one");
    expect(notice.textContent).toContain("src/b.test.ts > subtracts");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Log (last 4 KB)");
    expect(details.textContent).toContain("RAW LOG LINE");
    expect(notice.textContent).not.toContain("RAW LOG LINE");
    expect(notice.textContent).not.toContain(GATE_LOG_HEADING);
    await act(async () => {
      details.querySelector("summary")?.click();
    });
    expect(details.open).toBe(true);
  });

  it("shows a message without the heading whole, with no block", async () => {
    const root = await render("gate test failed\nsomething else", true);
    const notice = root.querySelector("[role=alert]");
    expect(notice?.textContent).toContain("gate test failed");
    expect(notice?.textContent).toContain("something else");
    expect(root.querySelector("details")).toBeNull();
  });
});
