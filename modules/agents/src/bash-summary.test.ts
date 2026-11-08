import { describe, expect, it } from "vitest";
import { bashSummary } from "./bash-summary.js";

describe("bashSummary", () => {
  it("drops a leading cd into a pi-spore worktree", () => {
    expect(bashSummary("cd /x/.pi-spore/worktrees/p/s-1 && npm test")).toBe("npm test");
    expect(bashSummary("cd /x/.pi-spore/worktrees/p/s-1; git status --short")).toBe(
      "git status --short",
    );
  });

  it("keeps other cd commands and commands without cd", () => {
    expect(bashSummary("cd src && ls")).toBe("cd src && ls");
    expect(bashSummary("npm run check")).toBe("npm run check");
  });

  it("shows the first line after the strip", () => {
    expect(bashSummary("cd /x/.pi-spore/worktrees/p/s-1 && git add -A\ngit commit -m x")).toBe(
      "git add -A",
    );
  });
});
