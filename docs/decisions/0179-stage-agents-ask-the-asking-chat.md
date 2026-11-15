# 0179. A stage agent asks the chat that started its pipeline, and the stage waits for the answer

- Status: Accepted
- Date: 2026-11-15
- Requirements: R3.5, R6, R6.6
- Changes: [ADR 0169](0169-remind-a-stage-agent-once-then-block.md)
- Builds on: [ADR 0162](0162-orchestrator-starts-pipeline-runs.md), [ADR 0008](0008-questions-up-the-chain.md)

## Context

- On 2026-11-14 a stage worker in a normal workspace needed a decision. It called `contact_supervisor` from the
  user's pi-subagents extension. That tool works only in a child that pi-subagents started, and a stage agent is a
  top-level Pi process, so the call failed. The worker wrote "No supervisor is reachable, so I'll decide" and
  guessed.
- Outside lanes a stage agent has only `request_human_input`. The stage rules never say whom to ask.
- Asking ends the agent's turn. `awaitReport` then sees an ended turn with no report. It sends the ADR 0169
  reminder at once and blocks the stage on the second empty turn. Nothing waits for an answer.
- Lanes already have the pattern: `ask_coordinator` and `answer_lane` (runs module).

## Decision

1. **The asking chat answers.** A stage agent outside a lane asks the chat that started its run: the run's
   `asking_agent_id`, usually the workspace's orchestrator chat (ADR 0162). That chat answers from its plan. When
   the plan does not say, it asks the user with `request_human_input` first, then answers.
2. **A closed asking chat.** When the user closed the asking chat, the question goes to the workspace's active
   worker chat (`agents.activeWorker`, which makes one when the workspace has none). That is the rule a run started
   from the Pipeline tab already uses for its asking chat. The question row records the chat that got it, and that
   chat also becomes the run's asking chat, so it gets the run's end message (ADR 0162).
3. **The pipelines module owns stage questions.** Table `pipelines_questions` (its own migration, ADR 0003):
   `id, run_id, turn_id, agent_id` (the stage agent), `asked_agent_id` (the chat that answers), `question, answer,
   state` (`open` or `answered`), `created_at, answered_at`.
4. **Tool `ask_orchestrator { question }`.** spore-bridge gives it to stage agents outside lanes. The agent calls it
   alone, as the last tool call of its turn, then stops, as with `ask_coordinator`. It posts to
   `POST /api/bridge/stage-questions` with the tool call id as its receipt (R16.3). The route refuses:
   - a caller that is not a stage agent: 403 `not_a_stage`;
   - a stage agent in a lane: 403 `in_lane` (it asks with `ask_coordinator`);
   - a caller that is not the agent of an open turn: 409 `turn_closed`. An open turn is a turn of a
     `running` run with no report and no error; a parallel review group has several (ADR 0178). Ask, answer, and
     the Pipeline tab use this one rule.
   In one transaction it writes the row and delivers the question to the asked chat with `agents.deliver`. The
   message names the run, the stage, the stage agent, and the question id, and says: answer from the plan with
   `answer_stage`; when the plan does not say, ask the user with `request_human_input` first, then call
   `answer_stage`. Read-only stage agents (reviewers) may ask.
5. **Tool `answer_stage { questionId, answer }`.** spore-bridge gives it to the orchestrator chat (a `worker` chat
   with no run role), the same chats that get `start_pipeline`. It posts to `POST /api/bridge/stage-answers` with a
   receipt. The route answers 404 `question_not_found` for an unknown id, 403 `not_asked` when the caller is not
   the question's asked chat, 409 `question_answered` for a question with an answer, and 409 `turn_closed` when the
   question's turn is no longer open (the turn reported, Retry replaced it, or the run ended). In one
   transaction it stores the answer and delivers it to the stage agent with the `Turn:` line. The delivery starts
   the agent's next run.
6. **The pipeline waits.** While an open turn has an open question, `awaitReport` waits for it: no reminder and no
   block. It checks for the question again after it reads the agent's session, as it does for the report, because
   the agent may ask while that read runs. This also holds after a restart: the restart reminder (R6.6) is skipped,
   because the answer's delivery starts the agent again. An agent whose run failed still blocks the stage, as
   before. Once the question has an answer, the reminder and block rule of ADR 0169 applies again.
7. **One path for questions.** Stage agents lose `request_human_input` outside lanes too, so every stage question
   goes through the path the pipeline waits for. Lane stage agents keep `ask_coordinator` and do not get
   `ask_orchestrator`. Stage workers start with `--exclude-tools contact_supervisor`, since that tool never works
   for them; stage reviewers already have a fixed allowlist. The stage rules say: when the brief leaves a decision
   open, ask with `ask_orchestrator` (in a lane: `ask_coordinator`); never use `contact_supervisor`; do not guess.
8. **The user sees why.** The Pipeline tab shows an open question on its turn: "Waiting for an answer from
   <chat>".
9. **Lane questions wait too.** A lane stage agent's `ask_coordinator` question holds its turn the same way: no
   reminder, no block, no restart reminder until `answer_lane`. The runs module keeps those questions in
   `runs_questions`, so the pipelines module learns of them through the lane lookup that runs gives it
   (`setLaneLookup`, ADR 0003). The lookup counts only questions the agent asked since the turn started. The Pipeline
   tab names the coordinator chat and links to it in the run workspace.

## Consequences

- A stage agent that needs a decision gets one from the plan or from the user, not a guess.
- An open question can hold a stage for as long as the asked chat takes. The Pipeline tab names that chat. The user
  can answer through it or stop the run.
- A question asked before the user closed its asked chat stays with that chat. The user stops the run, and a new
  run asks the active chat.
- A restart that stops the asked chat before it answers leaves the question open. The Pipeline tab names that chat,
  so the user can open it and ask it to answer. Lane questions have the same gap.
- This changes ADR 0169: a turn that ends on an open question is not "ended without a report".
