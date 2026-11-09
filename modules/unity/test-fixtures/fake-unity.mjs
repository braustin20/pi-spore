// A stand-in for the `unity` CLI in tests: fake-unity.mjs <state.json> <command> [args...]
// The state file holds { instances: [{ projectPath, pid, state }], calls: [argv...], openFails?, closeFails?,
// pipelineMissing?, testFails?, noReport?, testHangs? }.
//   status --json   prints the JSON envelope of CLI 1.0.0-beta.11 (exit 6 when no editor is found)
//   open <path>     adds an instance and creates <path>/Temp/UnityLockfile, like a starting editor
//   close <path>    removes the instance and the lock file. With pipelineMissing, only --force closes, as in the
//                   real CLI for a project without the Pipeline package (spike Q17): plain close exits 6 with the JSON error.
//   test <path> --mode M --output F   fails when an editor has <path> open, as Unity does for a locked project.
//                   Otherwise writes an NUnit report to F; with testFails it has one failed test and exits 1.
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

const flag = (name) => rest[rest.indexOf(name) + 1];

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
    // A string is the exact text of the failure, for tests of how close reads the CLI's output.
    console.error(
      typeof state.closeFails === "string" ? state.closeFails : "No graceful channel to the editor",
    );
    process.exit(1);
  }
  if (state.pipelineMissing && !rest.includes("--force")) {
    save();
    // The shape of `unity close --json` in CLI 1.0.0-beta.11 (spike Q17).
    console.log(
      JSON.stringify({
        success: false,
        command: "close",
        data: { project: target, closed: false, method: "none", reason: "pipeline_missing" },
        errors: [
          {
            code: "PROJECTS_CLOSE_PIPELINE_MISSING",
            message: `The editor for "${target}" is running, but the project doesn't include the com.unity.pipeline package. Re-run with --force to terminate the process.`,
          },
        ],
        warnings: [],
      }),
    );
    process.exit(6);
  }
  state.instances = (state.instances ?? []).filter((instance) => instance.projectPath !== target);
  rmSync(join(target, "Temp", "UnityLockfile"), { force: true });
  save();
} else if (command === "test") {
  save();
  if ((state.instances ?? []).some((instance) => instance.projectPath === target)) {
    console.error(`Cannot run batch mode: ${target} is already open in another Unity instance`);
    process.exit(1);
  }
  const failed = state.testFails ? 1 : 0;
  if (state.noReport) process.exit(0);
  writeFileSync(
    flag("--output"),
    `<test-run result="${failed ? "Failed" : "Passed"}" total="3" passed="${3 - failed}" failed="${failed}"></test-run>\n`,
  );
  console.log(`Running ${flag("--mode")} tests in ${target}`);
  if (failed) console.log("Failed: Calculator.Add_Negative expected 1 but was 2");
  console.log(`Total 3, passed ${3 - failed}, failed ${failed}`);
  // A hung editor: the report is on disk, but the process never ends by itself.
  if (state.testHangs) setInterval(() => {}, 1_000_000);
  else process.exit(failed ? 1 : 0);
} else {
  save();
  console.error(`fake-unity: unknown command ${command}`);
  process.exit(64);
}
