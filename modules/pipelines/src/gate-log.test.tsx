import { GATE_LOG_HEADING } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { splitRunMessage } from "./gate-log.js";

describe("splitRunMessage", () => {
  it("keeps the headline and failed tests as the notice, and the lines after the heading as the log", () => {
    const message = [
      "gate test failed",
      "2 tests failed:",
      "src/a.test.ts > adds > one",
      "",
      GATE_LOG_HEADING,
      "RAW LOG LINE",
    ].join("\n");
    expect(splitRunMessage(message)).toEqual({
      notice: "gate test failed\n2 tests failed:\nsrc/a.test.ts > adds > one",
      log: "RAW LOG LINE",
    });
  });

  it("keeps a message without the heading whole, with no log", () => {
    expect(splitRunMessage("gate test failed\nsomething else")).toEqual({
      notice: "gate test failed\nsomething else",
    });
  });
});
