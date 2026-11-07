import type { WebPage } from "@pi-spore/module-api";
import { describe, expect, it } from "vitest";
import { findPage, matchPath, railActive } from "./router.js";

describe("matchPath", () => {
  it("matches literal segments and captures params", () => {
    expect(matchPath("/projects/:id", "/projects/01AB")).toEqual({ id: "01AB" });
    expect(matchPath("/", "/")).toEqual({});
  });

  it("decodes params", () => {
    expect(matchPath("/w/:name", "/w/a%20b")).toEqual({ name: "a b" });
  });

  it("rejects different lengths and different literals", () => {
    expect(matchPath("/projects/:id", "/projects")).toBeUndefined();
    expect(matchPath("/projects/:id", "/workspaces/1")).toBeUndefined();
  });
});

describe("findPage", () => {
  it("returns the first page that matches", () => {
    const page = (path: string): WebPage => ({ path, title: path, component: () => null });
    const pages = [page("/projects"), page("/projects/:id")];
    expect(findPage(pages, "/projects/7")?.params).toEqual({ id: "7" });
    expect(findPage(pages, "/nope")).toBeUndefined();
  });
});

describe("railActive", () => {
  it("lights a page and the paths below it", () => {
    expect(railActive("/workspaces", "/workspaces")).toBe(true);
    expect(railActive("/workspaces", "/workspaces/01AB")).toBe(true);
    expect(railActive("/workspaces", "/workspacesX")).toBe(false);
    expect(railActive("/projects", "/workspaces/in/1")).toBe(false);
  });

  it("lights Home only on Home", () => {
    expect(railActive("/", "/")).toBe(true);
    expect(railActive("/", "/projects")).toBe(false);
  });
});
