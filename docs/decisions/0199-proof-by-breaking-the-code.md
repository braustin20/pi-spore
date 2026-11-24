# 0199. A test's proof may come from code broken on purpose; the brief suggests the tests

- Status: Accepted
- Date: 2026-11-24
- Requirements: R6.5
- Changes: [0016](0016-fail-first-proof.md) (how the proof is made, and who checks the tests)

## Context

ADR 0016 has the worker write each new test before the code and save its failing run. The user asked on 2026-11-23
to drop that order: it limits the implementer too much. What matters is the proof that a test can fail, not when the
test was written.

## Decision

- **Proof.** For each new test, the worker shows that the test can fail for the right reason. It either runs the
  test before the code exists, or, after the code works, breaks the code the test covers on purpose (for example,
  reverts one line), runs the test, sees it fail, and restores the code. It saves that failing run as a workspace
  artifact and lists the test with its path in every `report`, as before.
- **The brief suggests the tests.** The orchestrator's brief, and a coordinator's lane brief, name the tests to add:
  the behaviors to cover, where the tests go, and one test file to copy. The worker writes those tests, or better
  ones, and says in its report why it changed any.
- **The tests are checked on return.** After a run passes, the orchestrator checks that each suggested test, or a
  better one the report names, exists, and that together they cover the outcome, its edge cases, and its failure
  paths. Missing tests go back as a new pipeline run that names them. The coordinator does the same before
  `merge_lane`, with `revise_lane`.
- **Reviewers.** Both reviewers check that each test the brief suggests is there, or that the report says why not.
  A behavior the change adds with no test is a blocking finding. Each proof must show its test failing for the right
  reason; a new test without a proof is a blocking finding. The adversarial reviewer also names each edge case or
  failure path that no test covers.
- **Unchanged.** The gate key `fail_first = "artifact"`, its check of a non-empty proof for each listed test, and the
  message `missing fail-first proof for <test> (<path>)` stay, so existing pipeline files keep working. The gates
  still run only the final suite.

## Consequences

- The worker may write the code first. A proof from broken code is only as good as the break; the reviewers judge
  that it fails for the right reason.
- A brief takes a little longer to write, because it names the tests.
- `AGENTS.md` changes too: a bug fix comes with a test that fails without the fix.
