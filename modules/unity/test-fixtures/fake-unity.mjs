// A stand-in for the `unity` CLI in tests: fake-unity.mjs <state.json> <command> [args...]
// The state file holds { instances: [{ projectPath, pid, state }], calls: [argv...], openFails?, closeFails? }.
//   status --json   prints the JSON envelope of CLI 1.0.0-beta.11 (exit 6 when no editor is found)
//   open <path>     adds an instance and creates <path>/Temp/UnityLockfile, like a starting editor
//   close <path>    removes the instance and the lock file
// Every call is appended to `calls`, so tests can check that close never ran without a yes.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [stateFile, command, ...rest] = process.argv.slice(2);
let state;
try {
  state = JSON.parse(readFileSync(stateFile, "utf8"));
} catch (error) {
  console.error(`fake-unity: cannot read state file ${stateFile}: ${error.message}`);
  process.exit(70);
}
state.calls = [...(state.calls ?? []), [command, ...rest]];
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const target = rest.find((arg) => !arg.startsWith("--"));

if (command === "status") {
  save();
  const instances = state.instances ?? [];
  const found = instances.length > 0;
  console.log(
    JSON.stringify({
      success: found,
      command: "status",
      data: { count: instances.length, instances },
      errors: found ? [] : [{ code: "STATUS_NO_INSTANCES", message: "No Unity Editor instances" }],
      warnings: [],
    }),
  );
  process.exit(found ? 0 : 6);
} else if (command === "open") {
  if (state.openFails) {
    save();
    console.error("Editor version 6000.3.10f1 is not installed");
    process.exit(1);
  }
  state.instances = [
    ...(state.instances ?? []),
    { projectPath: target, pid: 4242, state: "ready", port: 7800 },
  ];
  mkdirSync(join(target, "Temp"), { recursive: true });
  writeFileSync(join(target, "Temp", "UnityLockfile"), "");
  save();
} else if (command === "close") {
  if (state.closeFails) {
    save();
    console.error("No graceful channel to the editor");
    process.exit(1);
  }
  state.instances = (state.instances ?? []).filter((instance) => instance.projectPath !== target);
  rmSync(join(target, "Temp", "UnityLockfile"), { force: true });
  save();
} else {
  save();
  console.error(`fake-unity: unknown command ${command}`);
  process.exit(64);
}
