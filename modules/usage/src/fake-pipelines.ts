import { type Pipelines, PipelinesKey } from "@pi-spore/mod-pipelines/server";
import type { ServerModule } from "@pi-spore/module-api";
import type { PipelineRun, PipelineTurn } from "@pi-spore/shared";

/** A turn that matters to the usage module: its kind, its stage, and the verdict of its report. */
interface FakeTurn {
  kind: PipelineTurn["kind"];
  stageIndex?: number;
  verdict?: "approve" | "revise";
}

export interface FakeRun {
  id: string;
  agentId?: string;
  state?: PipelineRun["state"];
  endedAt: number;
  turns?: FakeTurn[];
}

const THROWS = (): never => {
  throw new Error("not in this test");
};

/**
 * A module with id `pipelines` in place of the real one. `end` calls the listeners the usage module registered, as the
 * pipelines module does when a run ends.
 */
export function fakePipelines(): { module: ServerModule; end: (run: FakeRun) => void } {
  const listeners: ((run: PipelineRun) => void)[] = [];
  const implementation: Pipelines = {
    start: THROWS,
    report: THROWS,
    stop: THROWS,
    setLaneLookup: THROWS,
    get: THROWS,
    onChange: THROWS,
    afterRunEnded: (listener) => {
      listeners.push(listener);
    },
  };
  return {
    module: {
      id: "pipelines",
      requires: [],
      core: false,
      setup(host) {
        host.provide(PipelinesKey, implementation);
      },
    },
    end: (fake) => {
      // SAFETY: the usage module reads only the fields set here; the rest of a run is not needed by its listener.
      const run = {
        id: fake.id,
        workspaceId: "ws",
        state: fake.state ?? "passed",
        ...(fake.agentId === undefined ? {} : { workerAgentId: fake.agentId }),
        endedAt: fake.endedAt,
        turns: (fake.turns ?? []).map((turn, index) => ({
          id: `${fake.id}-turn-${index}`,
          stageIndex: turn.stageIndex ?? 0,
          kind: turn.kind,
          ...(turn.verdict
            ? { report: { turn: `${fake.id}-turn-${index}`, summary: "s", verdict: turn.verdict } }
            : {}),
        })),
      } as unknown as PipelineRun;
      for (const listener of listeners) listener(run);
    },
  };
}
