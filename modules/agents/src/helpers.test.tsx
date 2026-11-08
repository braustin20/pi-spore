// @vitest-environment happy-dom
import { type ApiClient, ApiContext } from "@pi-spore/module-api";
import type { ChildRun, ChildTranscript } from "@pi-spore/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Helpers } from "./helpers.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (state: ChildRun["state"]): ChildRun => ({
  id: "run1",
  label: "run1",
  state,
  steps: [{ id: "step:0", label: "worker", state, agent: "worker" }],
});

let container: HTMLElement;
let root: Root;
let paths: string[];
let reply: () => Promise<{ transcript: ChildTranscript }>;

beforeEach(() => {
  vi.useFakeTimers();
  paths = [];
  reply = async () => ({ transcript: { messages: [], truncated: false } });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const api = {
  get: (path: string) => {
    paths.push(path);
    return reply();
  },
} as unknown as ApiClient;

async function render(runs: ChildRun[]) {
  await act(async () => {
    root.render(
      <ApiContext value={api}>
        <Helpers agentId="a1" runs={runs} />
      </ApiContext>,
    );
  });
}

const button = (name: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
};

async function open() {
  await act(async () => button("Transcript").click());
}

describe("helper transcript", () => {
  it("says there are no messages yet for an empty reply", async () => {
    await render([run("running")]);
    await open();
    expect(container.textContent).toContain("No messages yet.");
  });

  it("shows the messages of a reply", async () => {
    reply = async () => ({
      transcript: {
        task: "Fix the bug",
        messages: [{ role: "assistant", kind: "text", text: "Reading the code" }],
        finalOutput: "Done",
        truncated: false,
      },
    });
    await render([run("complete")]);
    await open();
    expect(container.textContent).toContain("Fix the bug");
    expect(container.textContent).toContain("assistant: Reading the code");
    expect(container.textContent).toContain("Done");
    expect(container.textContent).not.toContain("No messages yet.");
  });

  it("asks for each step, because pi-subagents keeps a running run's session on its step", async () => {
    await render([run("running")]);
    await open();
    expect(paths).toEqual(["agents/a1/children/run1/transcript?child=step%3A0"]);
  });

  it("shows a failed read", async () => {
    reply = async () => {
      throw new Error("pi-subagents did not answer in time");
    };
    await render([run("running")]);
    await open();
    expect(container.textContent).toContain("pi-subagents did not answer in time");
  });

  it("refreshes a running helper while open, and stops when closed", async () => {
    await render([run("running")]);
    await open();
    expect(paths).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(paths).toHaveLength(2);
    await act(async () => button("Hide transcript").click());
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(paths).toHaveLength(2);
  });

  it("stops refreshing when the run ends", async () => {
    await render([run("running")]);
    await open();
    await render([run("complete")]);
    const afterEnd = paths.length;
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(paths).toHaveLength(afterEnd);
  });
});
