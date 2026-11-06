// Spike Q1 probe, loaded with `pi -e`. `/spore-probe` writes what this Pi process loaded to $SPORE_PROBE_OUT and
// opens one confirm dialog, so the driver can check that dialogs arrive over RPC.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spore-probe", {
    description: "pi-spore spike Q1 probe",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "pi-spore probe",
        "Does this dialog reach the RPC client?",
      );
      const models = ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`);
      const report = {
        pid: process.pid,
        confirmed,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        activeTools: pi.getActiveTools(),
        allTools: pi.getAllTools().map((tool) => tool.name),
        commands: pi.getCommands().map((command) => ({
          name: command.name,
          source: command.source,
          path: command.sourceInfo?.path,
        })),
        providers: [...new Set(models.map((id) => id.split("/")[0]))],
        modelCount: models.length,
        orcaEnv: Object.keys(process.env).filter((key) => key.startsWith("ORCA_")),
      };
      const out = process.env.SPORE_PROBE_OUT;
      if (!out) throw new Error("SPORE_PROBE_OUT is not set");
      writeFileSync(out, JSON.stringify(report, null, 2));
      ctx.ui.notify("pi-spore probe written", "info");
    },
  });
}
