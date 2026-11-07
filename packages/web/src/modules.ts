import { actionsWeb } from "@pi-spore/mod-actions/web";
import { agentsWeb } from "@pi-spore/mod-agents/web";
import { attentionWeb } from "@pi-spore/mod-attention/web";
import { changesWeb } from "@pi-spore/mod-changes/web";
import { kanbanWeb } from "@pi-spore/mod-kanban/web";
import { projectsWeb } from "@pi-spore/mod-projects/web";
import { terminalsWeb } from "@pi-spore/mod-terminals/web";
import { unityWeb } from "@pi-spore/mod-unity/web";
import { usageWeb } from "@pi-spore/mod-usage/web";
import { workspacesWeb } from "@pi-spore/mod-workspaces/web";
import type { WebModule } from "@pi-spore/module-api";

/** Every web module, in a plain list. */
export const webModules: readonly WebModule[] = [
  projectsWeb,
  workspacesWeb,
  agentsWeb,
  attentionWeb,
  actionsWeb,
  unityWeb,
  usageWeb,
  kanbanWeb,
  terminalsWeb,
  changesWeb,
];
