import type { ServerModule } from "@pi-spore/module-api";

/** Every server module, in a plain list. Order matters only between modules with no dependency between them. */
export const serverModules: readonly ServerModule[] = [];
