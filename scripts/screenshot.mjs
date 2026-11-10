// A look tool, not a test (ADR 0172): opens one page of this worktree's running dev server in headless Chromium,
// saves a full-page PNG, and says whether the page scrolls sideways. Start the server first with
// run_action { name: "dev", background: true }; it leaves its URL in <worktree>/.pi-spore-dev/url. The page is
// served with its token already in a meta tag, so this script never reads the token. Only the server's origin
// is loaded. The app routes by URL hash, so "/settings" opens <server>/#/settings. The app scrolls inside inner
// panes, not the document, so the viewport grows by their hidden height to get the whole page into one shot.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const worktree = dirname(dirname(fileURLToPath(import.meta.url)));
const devRoot = join(worktree, ".pi-spore-dev");

const USAGE =
  "Usage: node scripts/screenshot.mjs <path> [--width 1440] [--height <px>] [--theme <id>] [--out <file>]";

/** Prints a message and the usage to stderr, then exits 2. */
const badArgs = (message) => {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
};

/** Returns `value` as a positive integer, or exits 2 naming the option. */
const positiveInt = (name, value) => {
  if (!/^[1-9][0-9]*$/.test(value)) badArgs(`--${name} must be a positive integer, got "${value}"`);
  return Number(value);
};

/** Parses argv. Exits 2 on any bad argument. */
const parseArguments = (argv) => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        width: { type: "string", default: "1440" },
        height: { type: "string", default: "900" },
        theme: { type: "string" },
        out: { type: "string" },
      },
    });
  } catch (error) {
    return badArgs(error.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) badArgs("Give exactly one page path.");
  const [path] = positionals;
  if (!path.startsWith("/")) badArgs(`The page path must start with "/", got "${path}"`);
  return {
    path,
    width: positiveInt("width", values.width),
    height: positiveInt("height", values.height),
    theme: values.theme,
    out: values.out,
  };
};

/** Fails with the dev server hint unless the URL file exists and the server answers its health check. */
const findServer = async () => {
  const noServer = new Error(
    'No dev server. Start it with run_action { name: "dev", background: true }.',
  );
  let url;
  try {
    url = (await readFile(join(devRoot, "url"), "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") throw noServer;
    throw error;
  }
  const healthy = await fetch(`${url}api/health`).then(
    (response) => response.status === 200,
    () => false,
  );
  if (!healthy) throw noServer;
  return url;
};

/** Turns a page path into a file name part: "/settings/models" becomes "settings-models". */
const slug = (path) => path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";

/** Chromium cannot make a screenshot taller than this. */
const MAX_HEIGHT = 16384;

/** Returns the largest hidden height of any vertical scroll area on the page. */
const hiddenHeight = (page) =>
  page.evaluate(() => {
    let most = 0;
    for (const element of document.querySelectorAll("*")) {
      const { overflowY } = getComputedStyle(element);
      if (overflowY === "auto" || overflowY === "scroll") {
        most = Math.max(most, element.scrollHeight - element.clientHeight);
      }
    }
    return most;
  });

/** Returns the document and every horizontal scroll area that is wider than its box, at most 10. */
const sidewaysScrolls = (page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const areas = [root];
    for (const element of document.querySelectorAll("*")) {
      const { overflowX } = getComputedStyle(element);
      if (element !== root && (overflowX === "auto" || overflowX === "scroll")) areas.push(element);
    }
    return areas
      .filter((element) => element.scrollWidth > element.clientWidth)
      .slice(0, 10)
      .map((element) => ({
        name: [element.tagName.toLowerCase(), ...[...element.classList].slice(0, 3)].join("."),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
  });

/** Launches headless Chromium. A missing browser prints the install command and exits 1. */
const launch = async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error("Install the browser with: npx playwright install chromium");
    return process.exit(1);
  }
};

const args = parseArguments(process.argv.slice(2));
let browser;
try {
  const baseUrl = await findServer();
  const origin = new URL(baseUrl).origin;
  const out = resolve(
    args.out ?? join(devRoot, "screenshots", `${slug(args.path)}-${args.width}.png`),
  );
  await mkdir(dirname(out), { recursive: true });

  browser = await launch();
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  if (args.theme !== undefined) {
    await page.addInitScript((id) => localStorage.setItem("pi-spore.theme", id), args.theme);
  }
  const target = `${baseUrl}#${args.path}`;
  const response = await page.goto(target, { waitUntil: "networkidle" });
  if (!response?.ok()) throw new Error(`${target} answered ${response?.status() ?? "nothing"}`);

  const extra = await hiddenHeight(page);
  if (extra > 0) {
    await page.setViewportSize({
      width: args.width,
      height: Math.min(args.height + extra, MAX_HEIGHT),
    });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
  }
  const wide = await sidewaysScrolls(page);
  await page.screenshot({ path: out, type: "png", fullPage: true });

  console.log(`screenshot: ${out}`);
  console.log(`sideways scroll: ${wide.length > 0 ? "yes" : "no"}`);
  for (const { name, scrollWidth, clientWidth } of wide) {
    console.log(`  ${name}: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
