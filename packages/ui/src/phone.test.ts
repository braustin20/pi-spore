import { describe, expect, it } from "vitest";
import { paneHref, splitHash } from "./phone.js";

describe("splitHash", () => {
  it("splits the path from the pane, with or without the #", () => {
    expect(splitHash("#/workspaces/W/chats/C?pane=changes")).toEqual({
      path: "/workspaces/W/chats/C",
      pane: "changes",
    });
    expect(splitHash("/projects?pane=files")).toEqual({ path: "/projects", pane: "files" });
  });

  it("gives no pane when there is none", () => {
    expect(splitHash("#/projects")).toEqual({ path: "/projects", pane: undefined });
    expect(splitHash("#/projects?pane=")).toEqual({ path: "/projects", pane: undefined });
    expect(splitHash("#/projects?other=1")).toEqual({ path: "/projects", pane: undefined });
  });

  it("gives / for an empty path", () => {
    expect(splitHash("")).toEqual({ path: "/", pane: undefined });
    expect(splitHash("#")).toEqual({ path: "/", pane: undefined });
    expect(splitHash("#?pane=x")).toEqual({ path: "/", pane: "x" });
  });

  it("ignores other keys and decodes the pane", () => {
    expect(splitHash("#/a?x=1&pane=a%20b&y=2")).toEqual({ path: "/a", pane: "a b" });
  });
});

describe("paneHref", () => {
  it("adds the pane after the path", () => {
    expect(paneHref("/a/b", "changes")).toBe("#/a/b?pane=changes");
  });

  it("gives the bare path without a pane", () => {
    expect(paneHref("/a/b", undefined)).toBe("#/a/b");
  });

  it("encodes the pane and round-trips through splitHash", () => {
    expect(paneHref("/a", "a b&c")).toBe("#/a?pane=a%20b%26c");
    expect(splitHash(paneHref("/a", "a b&c"))).toEqual({ path: "/a", pane: "a b&c" });
  });
});
