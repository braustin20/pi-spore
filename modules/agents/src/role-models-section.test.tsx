// @vitest-environment happy-dom
import { type ApiClient, ApiContext, ApiRequestError } from "@pi-spore/module-api";
import type { RoleModelsResponse } from "@pi-spore/shared";
import { TooltipProvider } from "@pi-spore/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleModelsSection } from "./role-models-section.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODELS = {
  models: [
    { provider: "anthropic", id: "claude-a", name: "Claude A" },
    { provider: "openai", id: "gpt-x" },
  ],
};

const LIST: RoleModelsResponse = {
  roles: [
    { name: "orchestrator", kind: "role", model: "anthropic/claude-a" },
    { name: "worker", kind: "role", fallback: "orchestrator" },
    { name: "scout", kind: "subagent", description: "Looks around the code" },
    { name: "reviewer", kind: "subagent" },
  ],
};

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  document.body.innerHTML = "";
});

async function render(send: (method: string, path: string, body: unknown) => Promise<unknown>) {
  const api = {
    get: async (path: string) => {
      if (path === "agents/role-models") return LIST;
      if (path === "agents/models") return MODELS;
      throw new Error(`unexpected GET ${path}`);
    },
    send: vi.fn(send),
  } as unknown as ApiClient;
  container = document.body.appendChild(document.createElement("div"));
  const root = container;
  await act(async () => {
    createRoot(root).render(
      <ApiContext value={api}>
        <TooltipProvider>
          <RoleModelsSection />
        </TooltipProvider>
      </ApiContext>,
    );
  });
  return { root, send: api.send as ReturnType<typeof vi.fn> };
}

const picker = (root: Element, name: string) => {
  const found = root.querySelector<HTMLButtonElement>(`button[aria-label='Model for ${name}']`);
  if (!found) throw new Error(`no picker for ${name}`);
  return found;
};

const rowOf = (root: Element, name: string) => picker(root, name).closest("li") as HTMLElement;

const resetOf = (root: Element, name: string) => {
  const found = [...rowOf(root, name).querySelectorAll("button")].find(
    (each) => each.textContent === "Reset",
  );
  if (!found) throw new Error(`no Reset for ${name}`);
  return found;
};

const searchBox = () =>
  document.querySelector<HTMLInputElement>("input[aria-label='Search models']") as HTMLInputElement;

/** Opens the picker, searches for `query`, and presses Enter on the first match. */
async function choose(button: HTMLButtonElement, query: string) {
  await act(async () => button.click());
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(searchBox(), query);
    searchBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    searchBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

const withModel = (name: string, model: string | undefined): RoleModelsResponse => ({
  roles: LIST.roles.map((role) => {
    if (role.name !== name) return role;
    const { model: _old, ...rest } = role;
    return model === undefined ? rest : { ...rest, model };
  }),
});

describe("the Role models section", () => {
  it("lists roles and subagents in their groups, with descriptions and default labels", async () => {
    const { root } = await render(async () => LIST);
    const group = (title: string) =>
      root.querySelector(`section[aria-label='${title}']`) as HTMLElement;
    const names = (section: HTMLElement) =>
      [...section.querySelectorAll("button[aria-label^='Model for ']")].map((each) =>
        each.getAttribute("aria-label"),
      );
    expect(names(group("pi-spore agents"))).toEqual(["Model for orchestrator", "Model for worker"]);
    expect(names(group("Subagents"))).toEqual(["Model for scout", "Model for reviewer"]);
    expect(group("pi-spore agents").textContent).toContain("pi-spore agents");
    expect(group("Subagents").textContent).toContain("Subagents");

    expect(rowOf(root, "scout").textContent).toContain("Looks around the code");
    expect(picker(root, "orchestrator").textContent).toBe("Claude A");
    expect(picker(root, "worker").textContent).toBe("Same as orchestrator");
    expect(picker(root, "reviewer").textContent).toBe("Pi default");
    expect(resetOf(root, "orchestrator").disabled).toBe(false);
    expect(resetOf(root, "reviewer").disabled).toBe(true);
  });

  it("saves a picked model at once and shows the list the server answers", async () => {
    const { root, send } = await render(async () => withModel("scout", "openai/gpt-x"));
    await choose(picker(root, "scout"), "gpt-x");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("PUT", "agents/role-models/scout", {
      model: "openai/gpt-x",
    });
    expect(picker(root, "scout").textContent).toBe("openai/gpt-x");
    expect(resetOf(root, "scout").disabled).toBe(false);
  });

  it("resets a role with unset", async () => {
    const { root, send } = await render(async () => withModel("orchestrator", undefined));
    await act(async () => resetOf(root, "orchestrator").click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("PUT", "agents/role-models/orchestrator", { unset: true });
    expect(picker(root, "orchestrator").textContent).toBe("Pi default");
  });

  it("wraps a long model id in the picker instead of cutting it off", async () => {
    const { root } = await render(async () => LIST);
    const button = picker(root, "orchestrator");
    expect(button.className).toContain("h-auto");
    expect(button.className).not.toMatch(/(^| )h-8( |$)/);
    expect(button.className).toContain("[&>span]:whitespace-normal");
    expect(button.className).toContain("[&>span]:[overflow-wrap:anywhere]");
  });

  it("sends one save at a time, so the last answer holds every change", async () => {
    const answers: ((body: RoleModelsResponse) => void)[] = [];
    const { root, send } = await render(
      () => new Promise((resolve) => answers.push(resolve as (body: RoleModelsResponse) => void)),
    );
    await choose(picker(root, "scout"), "gpt-x");
    await choose(picker(root, "reviewer"), "claude a");
    // The server may finish two writes in either order, so the second waits for the first answer.
    expect(send).toHaveBeenCalledTimes(1);
    expect(picker(root, "reviewer").disabled).toBe(true);

    const scoutSaved = withModel("scout", "openai/gpt-x");
    await act(async () => answers[0]?.(scoutSaved));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("PUT", "agents/role-models/reviewer", {
      model: "anthropic/claude-a",
    });
    await act(async () =>
      answers[1]?.({
        roles: scoutSaved.roles.map((role) =>
          role.name === "reviewer" ? { ...role, model: "anthropic/claude-a" } : role,
        ),
      }),
    );
    expect(picker(root, "scout").textContent).toBe("openai/gpt-x");
    expect(picker(root, "reviewer").textContent).toBe("Claude A");
    expect(resetOf(root, "scout").disabled).toBe(false);
    expect(resetOf(root, "reviewer").disabled).toBe(false);
  });

  it("shows the server's message in the row when a save fails", async () => {
    const { root } = await render(async () => {
      throw new ApiRequestError(422, "unknown_model", "Unknown model openai/gpt-x");
    });
    await choose(picker(root, "scout"), "gpt-x");
    expect(rowOf(root, "scout").textContent).toContain("Unknown model openai/gpt-x");
    expect(rowOf(root, "reviewer").textContent).not.toContain("Unknown model");
  });
});
