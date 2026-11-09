import { describe, expect, it } from "vitest";
import { type ServerFacts, stopsServer } from "./guard.js";

const server: ServerFacts = {
  pid: 4242,
  pgid: 4240,
  port: 7420,
  comm: "node",
  args: "node /home/u/pi-spore/packages/server/dist/main.js",
};

describe("stopsServer", () => {
  it.each([
    'pkill -f "packages/server/dist/main.js"',
    "pkill -f pi-spore",
    "killall node",
    "kill 4242",
    "kill -9 4242",
    "kill -- -4240",
    "kill -9 -1",
    'kill "$PI_SPORE_SERVER_PID"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a bash variable, not a template.
    "kill ${PI_SPORE_SERVER_PID}",
    "fuser -k 7420/tcp",
    "fuser -km :7420",
    "kill $(lsof -ti:7420)",
    "kill `lsof -ti:7420`",
    "lsof -ti :7420 | xargs kill -9",
    "pkill -f 'dist/main\\.js'",
    'pkill -f "node /home/u/pi-spore/packages"',
    "sudo pkill node",
    "env FOO=1 timeout 5 /usr/bin/kill 4242",
    "(cd /tmp && kill 4242)",
    'pkill -f "packages/server/dist/main.js" ; pkill -f "ffprof-" ; cd ~/.pi-spore/x && git status --short',
  ])("blocks %s", (command) => {
    expect(stopsServer(command, server)).toBe(true);
  });

  it.each([
    "kill 12345",
    "kill 7420",
    "kill -0 4242",
    "kill -s 0 4242",
    "kill 4240",
    'pkill -f "ffprof-"',
    'pkill -f "ffprof-" ; cd ~/.pi-spore/x && git status --short',
    "git status",
    "echo 'pkill -f pi-spore'",
    'echo "kill 4242" 2>&1',
    "grep kill packages/server/src/main.ts",
    'pkill -f "node scripts/foo.js"',
    "fuser 7420/tcp",
    "pgrep -f ffprof | xargs kill",
  ])("allows %s", (command) => {
    expect(stopsServer(command, server)).toBe(false);
  });

  it("uses pid and port alone when ps could not be read", () => {
    const bare = { pid: 4242, port: 7420 };
    expect(stopsServer("kill 4242", bare)).toBe(true);
    expect(stopsServer("fuser -k 7420/tcp", bare)).toBe(true);
    expect(stopsServer("pkill vite", bare)).toBe(false);
  });
});
