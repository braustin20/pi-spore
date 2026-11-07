import { actionsModule } from "@pi-spore/mod-actions/server";
import { agentsModule } from "@pi-spore/mod-agents/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { bridgeModule } from "@pi-spore/mod-bridge/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { unityModule } from "@pi-spore/mod-unity/server";
import { usageModule } from "@pi-spore/mod-usage/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";

/** Every server module, in a plain list. Order matters only between modules with no dependency between them. */
export const serverModules: readonly ServerModule[] = [
  projectsModule,
  vcsGitModule,
  vcsFolderModule,
  workspacesModule,
  unityModule,
  agentsModule,
  actionsModule,
  attentionModule,
  bridgeModule,
  usageModule,
];
