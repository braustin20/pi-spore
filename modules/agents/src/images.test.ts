import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { type ChatMessage, type ChatState, isImageRef } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_PNG } from "../test-fixtures/png.mjs";
import { type AgentEvent, type AgentsModuleOptions, createAgentsModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../test-fixtures/fake-pi.mjs", import.meta.url));
const PNG = Buffer.from(FAKE_PNG, "base64");
/** A GIF header is enough for the type check. */
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");

let server: TestServer;
let scratch: string;
let agentsModule: ReturnType<typeof createAgentsModule>;

async function setup(options: AgentsModuleOptions = {}) {
  agentsModule = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({ provider: "fake", modelId: "fake-1", thinking: "high" }),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 5_000,
    ...options,
  });
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    vcsFolderModule,
    workspacesModule,
    agentsModule,
  ]);
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-images-")));
});
afterEach(async () => {
  await agentsModule?.manager().stopAll();
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function errorCode(response: Response, status: number): Promise<string> {
  return (await json<{ error: { code: string } }>(response, status)).error.code;
}

/** A folder project with one in-place workspace and its worker chat. */
async function makeAgent(name = "notes") {
  const folder = join(scratch, name);
  mkdirSync(folder, { recursive: true });
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await json<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "Chat",
      isolation: "in-place",
    }),
    201,
  );
  const { agent } = await json<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
    201,
  );
  return { agentId: agent.id, workspaceId: workspace.id, folder };
}

const events = (agentId: string) => server.events.eventsOf(`agent:${agentId}`) as AgentEvent[];
const piEvents = (agentId: string) =>
  events(agentId).flatMap((event) =>
    event.type === "pi" ? [event.event as Record<string, unknown>] : [],
  );
const runs = (agentId: string) =>
  piEvents(agentId).filter((event) => event.type === "agent_settled").length;

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function chat(agentId: string): Promise<ChatState> {
  const [snapshot] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return snapshot.chat;
}

const prompt = (agentId: string, body: Record<string, unknown>) =>
  server.request("POST", `/api/agents/${agentId}/prompt`, body);

const png = { mimeType: "image/png", data: FAKE_PNG };

const blocks = (message: ChatMessage | undefined) =>
  Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];

const imageRequest = (agentId: string, ref: string) =>
  server.request("GET", `/api/agents/${agentId}/images/${ref}`);

describe("images in the chat", () => {
  it("sends images with a prompt and shows them by ref, not as data", async () => {
    await setup();
    const { agentId } = await makeAgent();

    await json(await prompt(agentId, { message: "what is this?", images: [png] }));
    await until(() => runs(agentId) === 1);

    const state = await chat(agentId);
    const user = state.messages.find((message) => message.role === "user");
    const [text, image] = blocks(user);
    expect(text).toEqual({ type: "text", text: "what is this?" });
    expect(isImageRef(image)).toBe(true);
    expect(image).toEqual({
      type: "image",
      mimeType: "image/png",
      ref: expect.stringMatching(/^[0-9a-f]{64}$/),
      bytes: PNG.length,
    });
    expect(JSON.stringify(state)).not.toContain(FAKE_PNG);
    // Live events carry the ref too.
    expect(JSON.stringify(events(agentId))).not.toContain(FAKE_PNG);
    expect(state.messages.at(-1)?.content).toEqual([
      { type: "text", text: "echo: what is this? [1 images]" },
    ]);

    const response = await imageRequest(agentId, String(image?.ref));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    // The image is in memory, but only its own chat may read it.
    const other = await makeAgent("other");
    expect(await errorCode(await imageRequest(other.agentId, String(image?.ref)), 404)).toBe(
      "image_not_found",
    );
  });

  it("sends an image-only message and queues images while the agent works", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, { message: "", images: [png] }));
    await until(() => runs(agentId) === 1);

    await json(await prompt(agentId, { message: "slow:300" }));
    await until(
      () => piEvents(agentId).filter((event) => event.type === "agent_start").length === 2,
    );
    await json(
      await prompt(agentId, { message: "and this", images: [png, png], whileBusy: "followUp" }),
    );
    const queued = piEvents(agentId).find((event) => event.type === "queue_update");
    expect(queued?.followUp).toEqual(["and this [2 images]"]);
  });

  it("refuses bad images before they reach Pi", async () => {
    await setup({ maxImageBytes: 40, maxImagesPerMessage: 2 });
    const { agentId } = await makeAgent();
    const send = (body: Record<string, unknown>) => prompt(agentId, { message: "look", ...body });

    // A GIF that claims to be a PNG.
    expect(
      await errorCode(
        await send({ images: [{ mimeType: "image/png", data: GIF.toString("base64") }] }),
        400,
      ),
    ).toBe("bad_image");
    expect(
      await errorCode(
        await send({
          images: [{ mimeType: "image/png", data: Buffer.from("hello").toString("base64") }],
        }),
        400,
      ),
    ).toBe("bad_image");
    expect(
      await errorCode(
        await send({
          images: [{ mimeType: "image/png", data: Buffer.concat([PNG, PNG]).toString("base64") }],
        }),
        413,
      ),
    ).toBe("image_too_large");
    expect(
      await errorCode(
        await send({ images: [{ mimeType: "image/gif", data: GIF.toString("base64") }, png, png] }),
        400,
      ),
    ).toBe("too_many_images");
    expect(
      await errorCode(
        await send({ images: [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }] }),
        400,
      ),
    ).toBe("invalid_request");
    expect(
      await errorCode(
        await send({ images: [{ mimeType: "image/png", data: "not base64!" }] }),
        400,
      ),
    ).toBe("invalid_request");
    expect(await errorCode(await prompt(agentId, { message: "  " }), 400)).toBe("empty_prompt");
    // Nothing reached Pi, so no process started.
    expect(runs(agentId)).toBe(0);

    await json(await send({ images: [{ mimeType: "image/gif", data: GIF.toString("base64") }] }));
  });

  it("shows tool result images by ref and reads them back from the session file", async () => {
    // No cache: every image read goes to the session file.
    await setup({ imageCacheBytes: 0 });
    const { agentId } = await makeAgent();
    const other = await makeAgent("other");

    await json(await prompt(agentId, { message: "screenshot" }));
    await until(() => runs(agentId) === 1);
    const end = piEvents(agentId).find((event) => event.type === "tool_execution_end");
    expect(JSON.stringify(end)).not.toContain(FAKE_PNG);

    const result = (await chat(agentId)).messages.find((message) => message.role === "toolResult");
    const image = blocks(result).find(isImageRef);
    expect(image?.mimeType).toBe("image/png");
    const ref = String(image?.ref);

    const response = await imageRequest(agentId, ref);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);

    // After a stop the chat's history comes from the session file, with the same ref.
    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    const again = (await chat(agentId)).messages.find((message) => message.role === "toolResult");
    expect(blocks(again).find(isImageRef)?.ref).toBe(ref);
    expect((await imageRequest(agentId, ref)).status).toBe(200);

    // Another chat cannot read it; unknown and malformed refs are refused.
    expect(await errorCode(await imageRequest(other.agentId, ref), 404)).toBe("image_not_found");
    expect(await errorCode(await imageRequest(agentId, "0".repeat(64)), 404)).toBe(
      "image_not_found",
    );
    expect(await errorCode(await imageRequest(agentId, "not-a-ref"), 400)).toBe("bad_ref");
  });

  it("says which models take images", async () => {
    await setup();
    const { agentId } = await makeAgent();
    const { models } = await json<{ models: { id: string; input?: string[] }[] }>(
      await server.request("GET", `/api/agents/${agentId}/models`),
    );
    expect(models.map((model) => [model.id, model.input])).toEqual([
      ["fake-1", ["text", "image"]],
      ["fake-2", ["text"]],
    ]);
  });
});

describe("images the agent links", () => {
  const linked = (agentId: string, path: string) =>
    server.request("GET", `/api/agents/${agentId}/linked-image?path=${encodeURIComponent(path)}`);

  it("serves image files from the workspace folder and its artifacts folder", async () => {
    await setup();
    const { agentId, workspaceId, folder } = await makeAgent();
    mkdirSync(join(folder, "out"));
    writeFileSync(join(folder, "out", "shot.png"), PNG);
    writeFileSync(join(folder, "anim.GIF"), GIF);
    const artifacts = join(server.paths.artifacts, "workspaces", workspaceId);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "plot.png"), PNG);

    for (const path of ["out/shot.png", "./out/../out/shot.png", join(folder, "out", "shot.png")]) {
      const response = await linked(agentId, path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    }
    const gif = await linked(agentId, "anim.GIF");
    expect(gif.headers.get("content-type")).toBe("image/gif");
    expect((await linked(agentId, join(artifacts, "plot.png"))).status).toBe(200);
    // A symlink that stays inside the workspace is fine.
    symlinkSync(join(folder, "out", "shot.png"), join(folder, "latest.png"));
    expect((await linked(agentId, "latest.png")).status).toBe(200);
  });

  it("refuses paths outside the workspace, symlinks out, and files that are not images", async () => {
    await setup({ maxImageBytes: 100 });
    const { agentId, folder } = await makeAgent();
    const other = await makeAgent("other");
    writeFileSync(join(other.folder, "theirs.png"), PNG);
    const outside = join(scratch, "outside.png");
    writeFileSync(outside, PNG);
    writeFileSync(join(folder, ".env"), "SECRET=1");
    writeFileSync(join(folder, "notes.txt"), "hello");
    writeFileSync(join(folder, "fake.png"), "not a png");
    writeFileSync(join(folder, "big.png"), Buffer.concat([PNG, Buffer.alloc(200)]));
    mkdirSync(join(folder, "dir.png"));
    symlinkSync(outside, join(folder, "escape.png"));
    symlinkSync(join(folder, ".env"), join(folder, "secret.png"));
    // PNG bytes under another name: the real name must be an image name too.
    writeFileSync(join(folder, "data.bin"), PNG);
    symlinkSync(join(folder, "data.bin"), join(folder, "renamed.png"));
    symlinkSync(scratch, join(folder, "up"));

    const refused = async (path: string, status: number, code: string) =>
      expect(await errorCode(await linked(agentId, path), status), path).toBe(code);
    await refused("../outside.png", 403, "outside_root");
    await refused(outside, 403, "outside_root");
    await refused(join(other.folder, "theirs.png"), 403, "outside_root");
    await refused("../other/theirs.png", 403, "outside_root");
    await refused("escape.png", 403, "outside_root");
    await refused("up/outside.png", 403, "outside_root");
    await refused("secret.png", 415, "not_an_image");
    await refused(".env", 415, "not_an_image");
    await refused("renamed.png", 415, "not_an_image");
    await refused("notes.txt", 415, "not_an_image");
    await refused("fake.png", 415, "not_an_image");
    await refused("dir.png", 415, "not_a_file");
    await refused("big.png", 413, "file_too_large");
    await refused("missing.png", 404, "file_not_found");
    await refused("a\0b.png", 400, "bad_path");
    expect(
      await errorCode(await server.request("GET", `/api/agents/${agentId}/linked-image`), 400),
    ).toBe("bad_path");
    // The other workspace's own chat can read its own file.
    expect((await linked(other.agentId, "theirs.png")).status).toBe(200);
    expect(readFileSync(join(folder, ".env"), "utf8")).toBe("SECRET=1");
  });
});
