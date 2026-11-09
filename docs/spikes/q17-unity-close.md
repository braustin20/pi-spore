# Spike Q17: `unity close` without the Pipeline package

- Date: 2026-11-08
- Unity CLI 1.0.0-beta.11, editor 6000.3.10f1, Linux (Wayland session)
- Question: can `unity close <path>` close an editor whose project has no Pipeline package, or does it need
  `--force`? (ADR 0028, ADR 0153)
- Method: a new throwaway project in a temp folder (`ProjectVersion.txt`, an empty `Assets/`, a `manifest.json`
  with no Pipeline package). I started one editor on it with `unity open`, waited for `Temp/UnityLockfile`, and
  confirmed by its command line that the pid had `-projectpath` on that folder. I touched no other editor. Then I
  ran `unity close` on that folder twice, and deleted the folder.

## Answer

Plain `unity close` cannot close it. `--force` can.

| Command | Exit | Result |
|---|---|---|
| `unity status --json` | 0 | `data.instances: []`, error `STATUS_NO_INSTANCES`. The editor was running, but status does not see it without the package (as ADR 0028 found). |
| `unity close <path>` | 6 | Table row `Closed=false Method=none`. The editor kept running. |
| `unity close <path> --json` | 6 | `data.closed: false`, `data.method: "none"`, `data.reason: "pipeline_missing"`, error code `PROJECTS_CLOSE_PIPELINE_MISSING`. The message names the pid and says to run `unity pipeline install` or re-run with `--force`. |
| `unity close <path> --force --timeout 20` | 0 | `Closed=true Method=forced`. The editor was gone after about 5 s. |

## Notes

- The human output of the failed close is only the table. The error code is in the `--json` output, so pi-spore
  passes `--json` to read it.
- After the forced close, `Temp/UnityLockfile` stayed on disk (and `Temp/ProcessJobs`). With no process behind it
  the lock file counts as stale (ADR 0028), so it does not block.
- `--force` sends SIGTERM, then SIGKILL, so nothing is saved. A graceful close "exits without saving" too, so the
  user's yes means the same thing for both.
- Not checked: a project that has the Pipeline package (graceful close). pi-spore tries the plain close first, so it
  gets that path when it exists.

## `unity test` options (read from `--help`, not run)

I read `unity test --help` on the same CLI to check the arguments the gates use. I did not run a test.

- `unity test [options] [project]`: the folder is a positional argument.
- `--mode <mode>`: `EditMode` or `PlayMode`.
- `--output <path>`: where the report goes (NUnit XML by default).
- `--timeout <seconds>`: "Kill the Unity process after this many seconds" (off by default).

The gate passes all four, plus `--no-banner --non-interactive`. Because I did not run it, pi-spore also stops the
process itself if it has not exited a minute after the CLI timeout (ADR 0153).
