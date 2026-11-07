import {
  ApiContext,
  createInterfaceBroker,
  resolveModules,
  type WebPage,
} from "@pi-spore/module-api";
import { initTheme } from "@pi-spore/ui";
import { House } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createApiClient } from "./api.js";
import { HomePage } from "./HomePage.js";
import { webModules } from "./modules.js";
import "./app.css";

const api = createApiClient();
const pages: WebPage[] = [
  { path: "/", title: "Home", rail: { order: 0, icon: House }, component: HomePage },
];

// Same registry rules as the server: an invalid module list stops the app at load.
const broker = createInterfaceBroker();
for (const module of resolveModules(webModules)) {
  module.setup({
    ...broker.forModule(module),
    api,
    addPage: (page) => {
      if (pages.some((existing) => existing.path === page.path)) {
        throw new Error(
          `Module "${module.id}" adds page ${page.path}, which another module already added`,
        );
      }
      pages.push(page);
    },
  });
}

initTheme();
const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <ApiContext value={api}>
      <App pages={pages} />
    </ApiContext>
  </StrictMode>,
);
