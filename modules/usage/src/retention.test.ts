import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakePipelines } from "./fake-pipelines.js";
import { createUsageModule } from "./server.js";

const DAY = 86_400_000;
const START = 1_700_000_000_000;
// The test clock ticks once per call, so a restart time is a little past a whole number of days.
const SLACK = 10_000;

let home: string;
let server: TestServer | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-usage-retention-home-")));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retention: { days: 30 } }));
});
afterEach(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

const routingFile = (): string => join(home, "usage", "routing.jsonl");
const line = (at: number): string =>
  `${JSON.stringify({ at, kind: "initial", route: "cloud", reasons: [] })}\n`;
const UNREADABLE = "not json\n";

/** A routing log with a line at START, one 20 days later, and an unreadable one; the server starts `days` after START. */
async function startWithLog(days: number): Promise<void> {
  mkdirSync(join(home, "usage"), { recursive: true });
  writeFileSync(routingFile(), line(START) + line(START + 20 * DAY) + UNREADABLE);
  server = await createTestServer(
    [
      fakePipelines().module,
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      createUsageModule(),
    ],
    { home, startAt: START + days * DAY + SLACK },
  );
}

const outcomeIds = (): string[] =>
  (server as TestServer).store
    .all<{ run_id: string }>("SELECT run_id FROM usage_outcomes ORDER BY run_id")
    .map((row) => row.run_id);

/** Two ended runs, at START and 20 days later, stored by a first server; a second one starts `days` after START. */
async function startWithOutcomes(days: number): Promise<void> {
  const first = fakePipelines();
  const before = await createTestServer(
    [
      first.module,
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      createUsageModule(),
    ],
    { home, startAt: START },
  );
  first.end({
    id: "old",
    agentId: "a",
    endedAt: START,
    turns: [{ kind: "review", verdict: "approve" }],
  });
  first.end({ id: "new", agentId: "a", endedAt: START + 20 * DAY });
  before.close();
  const second = fakePipelines();
  server = await createTestServer(
    [
      second.module,
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      createUsageModule(),
    ],
    { home, startAt: START + days * DAY + SLACK },
  );
}

describe("usage retention", () => {
  it("deletes routing lines older than the limit and keeps newer and unreadable ones", async () => {
    await startWithLog(31);
    expect(readFileSync(routingFile(), "utf8")).toBe(line(START + 20 * DAY) + UNREADABLE);
  });

  it("keeps every routing line inside the limit", async () => {
    await startWithLog(29);
    expect(readFileSync(routingFile(), "utf8")).toBe(
      line(START) + line(START + 20 * DAY) + UNREADABLE,
    );
  });

  it("deletes outcome rows older than the limit and keeps newer ones", async () => {
    await startWithOutcomes(31);
    expect(outcomeIds()).toEqual(["new"]);
  });

  it("keeps every outcome row inside the limit", async () => {
    await startWithOutcomes(29);
    expect(outcomeIds()).toEqual(["new", "old"]);
  });
});
