import { HomeItemsKey } from "@pi-spore/mod-attention/server";
import type { ServerModule } from "@pi-spore/module-api";

/** A module with id `attention` in place of the real one, for tests that do not look at Home. */
export const fakeAttention: ServerModule = {
  id: "attention",
  requires: [],
  core: false,
  setup(host) {
    host.provide(HomeItemsKey, { register: () => {}, changed: () => {} });
  },
};
