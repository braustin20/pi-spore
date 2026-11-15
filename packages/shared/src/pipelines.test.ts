import { describe, expect, it } from "vitest";
import { type PipelineStage, stageGroups } from "./pipelines.js";

const worker: PipelineStage = { name: "implement", role: "worker" };
const reviewer = (name: string, withPrevious?: boolean): PipelineStage => ({
  name,
  role: "reviewer",
  ...(withPrevious === undefined ? {} : { with_previous: withPrevious }),
});
const gates: PipelineStage = { name: "gates", gates: ["check"] };

describe("stageGroups", () => {
  it("joins a stage with with_previous to the group before it", () => {
    expect(stageGroups([worker, reviewer("review"), reviewer("adversarial", true), gates])).toEqual(
      [[0], [1, 2], [3]],
    );
  });

  it("puts every stage alone when no stage has the key", () => {
    expect(stageGroups([worker, reviewer("review"), reviewer("adversarial"), gates])).toEqual([
      [0],
      [1],
      [2],
      [3],
    ]);
  });

  it("holds three reviewers in one group", () => {
    expect(stageGroups([worker, reviewer("a"), reviewer("b", true), reviewer("c", true)])).toEqual([
      [0],
      [1, 2, 3],
    ]);
  });
});
