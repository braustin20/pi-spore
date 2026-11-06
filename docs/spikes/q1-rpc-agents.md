# Spike Q1: Pi agents in RPC mode

- Date: 2026-11-06
- Pi: 1.5.0, Node 26.7.0, Linux
- Code: `spikes/q1-rpc/` (`drive.mjs` starts `pi --mode rpc` the way pi-spore will; `probe.ts` reports what loaded)
- Question: does `pi --mode rpc` load the user's whole Pi setup, do extension dialogs reach the client, and how
  much memory does one agent use? (ADR 0002)

## Answer

Yes, everything loads, and dialogs work. Memory per busy agent is about 0.5 to 0.9 GB, not the 150 to 350 MB first
estimated. Most of the difference is processes that extensions start, not Pi itself.

## What loaded

One agent, started with `pi --mode rpc --no-session` and the user's normal settings:

| Item | Count | Notes |
|---|---|---|
| Extension commands | 46 | pi-subagents 19, pi-lens 9, pi-mcp-adapter 4, pi-web-access 4, claude-bridge and others 4, strata-model, tabby-model, model-browser, pi-splash, built-in llama.cpp |
| Skills | 10 | |
| Prompt templates | 6 | |
| Providers | 7 | claude-bridge, strata, llama-cpp, tabbyapi, openai, openrouter, opencode-go (454 models) |
| Tools | 106 (26 active) | built-ins, subagents, pi-lens, web access, `mcp__unity_mcp__*`, `mcp__blender_mcp__*` |

Startup to the first `get_state` answer: about 1.2 s.

## Dialogs and UI records

- The probe's `ctx.ui.confirm()` arrived as an `extension_ui_request` with `method: "confirm"`. The driver answered
  `confirmed: true`, and the extension received `true`.
- Extensions also sent `setStatus`, `setWidget`, and `notify` records. pi-spore can show these or ignore them.
- In the extension, `ctx.mode` is `rpc` and `ctx.hasUI` is `true`.

## Memory

PSS (each process's fair share of memory) summed over the agent's process tree. The machine was under memory
pressure during the test (about 2 GB free, 13 GB of swap in use). Pages in swap do not count, so these numbers are
lower bounds.

| Moment | Total | Breakdown |
|---|---|---|
| Ready (about 1 s) | 250 MB | `pi` only |
| Settled (15 s, TypeScript repo) | 580 MB | `pi` 170, pi-lens TypeScript language server about 410 (server, two `tsserver`, typings installer) |
| Busy, short task on `claude-bridge/claude-haiku-5-5` | 840 MB peak | adds a `claude` process (about 190 MB) that claude-bridge runs during a request |
| 20 s after the task | 260 MB+ | partly swapped out, so not reliable |
| Long session (47 MB file, 551 messages), ready | 335 MB | `pi` only; opened in 1.1 s |
| Long session, settled | 490 MB | plus the pi-lens servers |

Where the memory goes:

- **pi-lens** starts language servers for the agent's working folder about 10 s after launch. TypeScript costs about
  410 MB. In Unity projects it would start a C# server (`csharp-ls` or OmniSharp), not measured. pi-lens
  stops idle servers after 20 minutes by default (`PI_LENS_LSP_IDLE_EVICT_MS`).
- **claude-bridge** runs a `claude` process while a request is in flight, about 190 MB.
- **Pi itself** uses 170 to 335 MB, depending on session size.

Rough budget: 0.5 GB for an idle agent with its language server, 0.9 GB for a busy one. Five busy agents need about
4.5 GB. One Unity editor needs several GB more.

## Findings that change the design

1. **Strip the host terminal's identity.** The test shell had 19 `ORCA_*` variables. A child Pi that inherits them
   reports its status into Orca's pane. pi-spore removes `ORCA_*` and `HERDR_*` from every agent's environment.
2. **A session with a missing working folder hangs.** When the folder stored in a session file no longer exists,
   `pi --mode rpc --session <file>` prints a note to stderr and waits forever. It does not exit or answer. This
   will happen for archived workspaces whose worktree was removed. pi-spore must:
   - check the stored folder before it starts Pi with `--session`;
   - show archived transcripts by reading the session file itself, without starting Pi;
   - time out every agent start, and report its stderr.
3. **Language servers dominate memory.** Decided later: agents run without pi-lens (ADR 0025) and live agents are
   limited (ADR 0026).
4. **Only one `claude` process per request.** claude-bridge does not keep one running between requests, so idle
   agents on Claude do not pay for it.
