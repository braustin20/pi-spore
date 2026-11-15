# 0178. Read-only stages of a pipeline run together in a parallel group

- Status: Proposed
- Date: 2026-11-15
- Requirements: R6.1, R6.3, R6.4, R6.5, R6.6, R3.6, R12.2
- Changes: [ADR 0006](0006-declared-pipelines.md), [ADR 0015](0015-review-rounds.md),
  [ADR 0016](0016-fail-first-proof.md), [ADR 0158](0158-revise-lane-is-a-fix-pass.md) for the built-in pipelines

## Context

- A pipeline runs its stages one after the other. The built-in `default` is implement, review (at most 2 rounds),
  adversarial, gates (R6.3). Each card's orchestrator sends every slice through it (ADR 0162).
- Review, adversarial, and gates change no files. A reviewer reads a diff artifact that the stage writes before the
  round starts. A gate runs actions on the working copy. The worker is idle while they work.
- So the wait after the worker is the sum of every reviewer turn, every fix, and the gates. Each stage also gets
  its own fix pass: the adversarial reviewer sees code that review already made the worker change, and the gates see
  it only at the end.
- A red gate today ends the run `failed`. The orchestrator then starts a new run for a failure that one fix would
  often clear.
- Stages run in one `pipelines.stage` job per workspace (ADR 0004), one stage at a time.

## Decision

### File syntax

1. A stage may set `with_previous = true`. It joins the parallel group of the stage before it. A stage without the
   key starts a new group. A group of one stage runs as today.
2. The key is allowed on reviewer stages and gate stages. It is refused, with 422 `bad_pipeline` naming the file and
   the stage, on the worker stage and on the stage right after it, because a group never holds the worker stage.
   `with_previous = false` is the same as no key.
3. Stage names stay unique in a file. Members keep their own keys (`rounds`, `fix_passes`, `early_stop`,
   `min_strength_over`, `gates`, `fail_first`).

### Rounds

4. A group runs in rounds. Round k starts, at the same time, each reviewer member that is still open and every gate
   member. A reviewer member is open until it APPROVEs, it has used its `rounds`, or Jev stops it. The diff artifact
   of round k (`pipelines/<run>/<stage>-<k>.diff`) is written once before any member starts, and all reviewers of
   the round read the same content.
5. Round k ends when every member in it has ended: each reviewer reported, each gate member ran its gates. A
   member that waits (blocked, a settings error, a Unity editor question) holds the round. The others keep working.
   A reviewer whose reported models fail `min_strength_over` ends the run `failed`, as today.
6. If no reviewer said REVISE and no gate is red, the group ends and the next group starts.
7. **Round limit question.** If a reviewer said REVISE on its last round and has `fix_passes = 0`, the run asks the
   user before the fix, as today (`pipeline-round-limit`, fix, accept, or stop). One question lists every such
   member and its findings. Fix keeps their findings in the fix. Accept drops them. Stop stops the run. When accept
   leaves nothing to fix, the group ends.
8. **One fix.** Otherwise the run's worker gets one fix turn. It holds every REVISE finding, each under its stage
   name, and each red gate's headline and log path, the text a gate failure shows today. There is one fix turn per
   round, never one per member.
9. **After the fix.** A reviewer member stays open when it said REVISE, k is less than its `rounds`, and Jev did not
   stop it. If any reviewer member is open, round k + 1 starts with those members and every gate member. Its
   reviewers get their own previous findings and the fix report, as round 2 does today.
10. **Final gate run.** If no reviewer member is open after a fix, the gate members run once more, alone. Green
   ends the group. Red ends the run `failed`, as a red gate does today. That run gets no fix.
11. A group with no reviewer member gets no fix. A red gate ends the run `failed`, as today.
12. Round limits stay hard (R6.4). No member runs more rounds than it declares. A fix adds no review round. Jev
   still only ends a member's rounds. A group makes at most as many fixes as its largest `rounds`, and runs its
   gates at most one more time than that.

### Gates in a group

13. A gate member runs its gates in order, as today. Two gate members run at the same time.
14. Before each gate run, the gate member checks the fail-first proofs of the run's manifest (ADR 0016). The
   manifest grows with each fix report, so it is checked every round. A missing proof is a red gate with the
   headline `missing fail-first proof for <test> (<path>)`. It gets the fix like any red gate. The gates run only
   the final suite. They never run a recorded failing run again (R6.5).
15. The action key of a gate run holds the round: `<run>:<stage>:<round>:<action>:<attempt>`. A re-run after a fix
   must start a new action run, and a restart must get the same one back (R6.6).
16. A gate must not change tracked files. Reviewers read a diff written at the start of the round; a gate that
   writes tracked files would change the tree under them. `check` and `test` only read. Reviewers have no shell
   tool, so they run nothing next to the gates.

### Unity

17. Unity test gates are provided actions, exclusive per folder (ADR 0156). The actions runner queues exclusive runs
   per folder (R12.2), so two Unity test gates never run at the same time in one worktree. When a group has two
   Unity gates, in one gate member or in two, the second waits in the actions queue until the first ends. The group
   waits for both. The editor lease handoff runs once per gate run, as today, and a question left open is reused,
   not filed twice. The same queue holds any project action with `exclusive = true`.
18. To run both Unity modes, list them in one gate member: `gates = ["check", "unity-test-editmode",
   "unity-test-playmode"]`. Two gate members would run in the same order, but one member says it plainly.

### Built-in pipelines

19. `default` puts `adversarial` and `gates` in the group of `review`:

```toml
id = "default"

[[stage]]
name = "implement"
role = "worker"
tier = "route"

[[stage]]
name = "review"
role = "reviewer"
rounds = 2
early_stop = "jev"
fix_passes = 1
min_strength_over = "implement"

[[stage]]
name = "adversarial"
role = "adversarial-reviewer"
with_previous = true      # runs next to review; its findings join the same fix
rounds = 1
fix_passes = 1

[[stage]]
name = "gates"
with_previous = true      # runs while the reviewers read; runs again after every fix
gates = ["check", "test"]
fail_first = "artifact"
```

   Round 1 runs review, adversarial, and gates. One fix gets all their findings. Round 2 runs review (if it said
   REVISE and Jev did not stop it) and gates. After the last fix, gates run alone. Today's worst case is 3 reviewer
   turns, 3 fixes, and 1 gate run, all in a line. The new worst case is 3 reviewer turns, 2 fixes, and 3 gate runs,
   in 2 rounds.
20. `light` puts `gates` in the group of `review`:

```toml
id = "light"

[[stage]]
name = "implement"
role = "worker"
tier = "route"

[[stage]]
name = "review"
role = "reviewer"
rounds = 2
fix_passes = 1
early_stop = "jev"
min_strength_over = "implement"

[[stage]]
name = "gates"
with_previous = true
gates = ["check", "test"]
fail_first = "artifact"
```

21. `revise` puts `gates` in the group of `review`:

```toml
id = "revise"

[[stage]]
name = "fix"
role = "worker"
worker = "reuse"

[[stage]]
name = "review"
role = "reviewer"
rounds = 1
fix_passes = 1
min_strength_over = "fix"

[[stage]]
name = "gates"
with_previous = true
gates = ["check", "test"]
fail_first = "artifact"
```

### Jobs and state

22. A group is one `pipelines.stage` job, keyed by the workspace as today, so the workspace still runs one group at a
   time (ADR 0004). Its subject's `stageIndex` is the group's first stage, and the run's `stage_index` points there
   while the group runs. The checkpoint holds the round and each gate member's place (`gate`, `attempt`).
23. Each turn keeps the stage index of its member. The fix turn belongs to the worker stage, as fix rows do today,
   and records the members whose findings it holds.
24. A restart in a group resumes it (R6.6). Turns already reported are not run again. A reviewer turn still open
   gets the restart note, as today. A gate run that a restart cut off starts again under the next attempt.

### Limits

25. A group's reviewers are live agents at the same time. The default group adds one live agent next to the idle
   worker. The 8-slot limit (`agents.maxLive`, ADR 0026) applies. A reviewer that gets no slot waits in the queue,
   and the idle worker may be stopped to free one.
26. A group is faster only when its reviewers run on cloud models. Two reviewers on one local target with
   `concurrency = 1` (ADR 0010) wait for its one slot. They run one after the other, as today, and the group saves
   only the gate time.

### UI

27. The Pipeline tab's step bar shows a group as one step. Its members sit side by side inside it, each with its own
   state and counts. A click on a member scrolls to that stage. The timeline lists turns by `createdAt`, as today,
   so parallel turns sit next to each other. The working label names the group's stages: `Pipeline: review,
   adversarial, gates`, with `, round <n>` from round 2.

## Consequences

- A `default` slice waits for at most 2 review rounds instead of 3 reviewer turns in a line, and its gates run while
  the reviewers read. The adversarial reviewer now sees the code before review's fix, not after it.
- Findings of several reviewers go into one fix. A fix may have to settle two reviewers who disagree. Round 2's
  reviewer still checks its own earlier findings first.
- A red gate no longer ends a run at once when the group has a reviewer. It gets one fix. The fix after the last
  round has no review after it, only the final gate run, as the last fix pass has today (ADR 0015 note).
- The gates run more often: once per round, and once after the last fix. A slow suite costs more machine time. It
  costs no extra waiting, because it runs next to a reviewer turn.
- A missing fail-first proof gets a fix instead of failing the run. The reviewer still checks each proof.
- Two reviewer agents may be live at once. Machines with little memory feel it sooner (ADR 0026).
- Pipeline files without `with_previous` behave exactly as before. A user or project `default`, `light`, or `revise`
  file keeps its own stages.
- Card "Parallel stages 2" builds the reviewer group, rules 1 to 12 for reviewers, 22 to 27, and `default` with
  adversarial in the group. Card "Parallel stages 3" builds the gate members, rules 13 to 18, and the gates in all
  three built-in pipelines.
