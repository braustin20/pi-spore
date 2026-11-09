import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAgentsModule } from "./server.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-spore-agents-settings-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it("refuses to start on a bad agents value, naming the key and the file", async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), '{"agents":{"maxLive":0}}');
  const start = createTestServer(
    [projectsModule, vcsGitModule, vcsFolderModule, workspacesModule, createAgentsModule()],
    { home },
  );
  await expect(start).rejects.toThrow(/settings\.json: agents\.maxLive/);
});
