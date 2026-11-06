import { createInterfaceBroker, resolveModules } from "@pi-spore/module-api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { webModules } from "./modules.js";

// Same registry rules as the server: an invalid module list stops the app at load.
const modules = resolveModules(webModules);
const broker = createInterfaceBroker();
for (const module of modules) module.setup(broker.forModule(module));

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App modules={modules.map((module) => module.id)} />
  </StrictMode>,
);
