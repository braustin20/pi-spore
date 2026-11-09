import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@pi-spore/module-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_DEFAULT,
  BUILT_IN_REVISE,
  loadPipelines,
  type PipelineEntry,
  parsePipeline,
} from "./files.js";

let scratch: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-pipelines-")));
  userDir = join(scratch, "user");
  projectDir = join(scratch, "project");
  mkdirSync(userDir);
  mkdirSync(projectDir);
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const implementOnly = (id: string, extra = "") => `id = "${id}"

[[stage]]
name = "implement"
role = "worker"
${extra}`;

const write = (dir: string, id: string, text: string) => {
  writeFileSync(join(dir, `${id}.toml`), text);
  return join(dir, `${id}.toml`);
};

const entryOf = async (id: string): Promise<PipelineEntry> => {
  const found = (await loadPipelines(userDir, projectDir)).find((entry) => entry.id === id);
  if (!found) throw new Error(`No pipeline ${id}`);
  return found;
};

/** The 422 a file raises, with its message. */
const refusal = (text: string, source: "user" | "project" = "user", name = "p") => {
  try {
    parsePipeline(Buffer.from(text), name, source, `/files/${name}.toml`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "bad_pipeline" });
    return (error as ApiError).message;
  }
  throw new Error("The file was accepted");
};

describe("pipeline files", () => {
  it("lets a project file win over a user file with the same id", async () => {
    write(userDir, "p", implementOnly("p"));
    const projectPath = write(
      projectDir,
      "p",
      `${implementOnly("p")}\n[[stage]]\nname = "gates"\ngates = ["check"]\n`,
    );
    write(userDir, "other", implementOnly("other"));

    const entries = await loadPipelines(userDir, projectDir);

    expect(entries.map((entry) => [entry.id, entry.source])).toEqual([
      ["default", "built-in"],
      ["other", "user"],
      ["p", "project"],
      ["revise", "built-in"],
    ]);
    expect(entries.find((entry) => entry.id === "p")).toMatchObject({ path: projectPath });
  });

  it("lists the built-in default, with a hash, when no file has the id default", async () => {
    const entry = await entryOf("default");

    expect(entry).toMatchObject({
      source: "built-in",
      hash: createHash("sha256").update(BUILT_IN_DEFAULT).digest("hex"),
    });
    expect("stages" in entry && entry.stages.map((stage) => stage.name)).toEqual([
      "implement",
      "review",
      "adversarial",
      "gates",
    ]);
    expect(entry).not.toHaveProperty("path");
  });

  it("lists the built-in revise pipeline: a fix by the reused worker, one review, then the gates", async () => {
    const entry = await entryOf("revise");

    expect(entry).toMatchObject({
      source: "built-in",
      hash: createHash("sha256").update(BUILT_IN_REVISE).digest("hex"),
      stages: [
        { name: "fix", role: "worker", worker: "reuse" },
        {
          name: "review",
          role: "reviewer",
          rounds: 1,
          fix_passes: 1,
          min_strength_over: "fix",
        },
        { name: "gates", gates: ["check", "test"], fail_first: "artifact" },
      ],
    });
    expect(entry).not.toHaveProperty("path");
  });

  it("uses a project file named revise in place of the built-in one", async () => {
    write(projectDir, "revise", implementOnly("revise"));

    expect(await entryOf("revise")).toMatchObject({ source: "project" });
  });

  it("allows worker reuse only on the worker stage, and never with a model or tier", () => {
    const reviewer = `${implementOnly("p")}\n[[stage]]\nname = "review"\nrole = "reviewer"\nworker = "reuse"\n`;
    expect(refusal(reviewer)).toBe(
      '/files/p.toml: stage "review": key "worker" is not allowed on a reviewer stage',
    );
    expect(refusal(implementOnly("p", 'worker = "reuse"\nmodel = "fake/a-1"'))).toBe(
      '/files/p.toml: stage "implement": worker = "reuse" keeps the earlier worker and its model; remove model and tier',
    );
    expect(refusal(implementOnly("p", 'worker = "reuse"\ntier = "route"'))).toContain(
      'worker = "reuse" keeps the earlier worker and its model',
    );
  });

  it("uses a user file named default in place of the built-in one", async () => {
    write(userDir, "default", implementOnly("default"));

    expect(await entryOf("default")).toMatchObject({ source: "user" });
  });

  it("keeps a bad file in the list with its error, and does not fall back for a bad default", async () => {
    const path = write(
      userDir,
      "default",
      'id = "default"\n[[stage]]\nname = "implement"\nrole = "worker"\nnope = 1\n',
    );

    const entry = await entryOf("default");

    expect(entry).toMatchObject({ source: "user", path });
    expect("error" in entry && entry.error).toContain(
      `${path}: stage "implement" has unknown key "nope"`,
    );
  });

  it("names the file and the key of an unknown key, with status 422", () => {
    expect(refusal(implementOnly("p", "colour = 1"))).toBe(
      '/files/p.toml: stage "implement" has unknown key "colour"',
    );
    expect(refusal(`${implementOnly("p")}\n[extra]\nx = 1\n`)).toBe(
      '/files/p.toml: unknown key "extra"',
    );
  });

  it("refuses a model in a project file with the R17.3 error, and accepts it in a user file", () => {
    const text = implementOnly("p", 'model = "fake/strong-1"');

    expect(refusal(text, "project")).toBe(
      '/files/p.toml: stage "implement": model is not allowed in project pipeline files (R17.3); set it in ~/.pi-spore/pipelines/p.toml',
    );
    const pipeline = parsePipeline(Buffer.from(text), "p", "user", "/files/p.toml");
    expect(pipeline.stages[0]).toMatchObject({ model: "fake/strong-1" });
  });

  it("requires the id to match the file name", () => {
    expect(refusal(implementOnly("other"))).toBe(
      '/files/p.toml: id "other" must equal the file name "p"',
    );
  });

  it("says a tier other than route is not built", () => {
    expect(refusal(implementOnly("p", 'tier = "heavy"'))).toBe(
      '/files/p.toml: stage "implement": tier heavy is not built; use route or model',
    );
    expect(refusal(implementOnly("p", 'tier = "route"\nmodel = "fake/a-1"'))).toContain(
      "set model or tier, not both",
    );
  });

  it("refuses a second worker stage, and a first stage that is not the worker", () => {
    const second = `${implementOnly("p")}\n[[stage]]\nname = "again"\nrole = "worker"\n`;
    expect(refusal(second)).toBe(
      '/files/p.toml: stage "again": only the first stage may be the worker stage',
    );
    const reviewFirst = 'id = "p"\n[[stage]]\nname = "review"\nrole = "reviewer"\n';
    expect(refusal(reviewFirst)).toBe("/files/p.toml: the first stage must be the worker stage");
  });

  it("refuses keys of the other kind of stage", () => {
    expect(refusal(implementOnly("p", "rounds = 2"))).toBe(
      '/files/p.toml: stage "implement": key "rounds" is not allowed on a worker stage',
    );
    const gate = `${implementOnly("p")}\n[[stage]]\nname = "gates"\ngates = ["check"]\nrole = "reviewer"\n`;
    expect(refusal(gate)).toContain("an agent stage or a gate stage, never both");
  });

  it("stores the SHA-256 of the file's bytes", () => {
    const bytes = Buffer.from(implementOnly("p"));

    const pipeline = parsePipeline(bytes, "p", "user", "/files/p.toml");

    expect(pipeline.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
