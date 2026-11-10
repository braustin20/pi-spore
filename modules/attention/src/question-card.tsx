import { useApi } from "@pi-spore/module-api";
import type { Question, QuestionOption, QuestionStep, StepAnswer } from "@pi-spore/shared";
import { Button, Chip, cn, Markdown, Textarea } from "@pi-spore/ui";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

/**
 * The user's unsent answer to one step. `picked`: the chosen labels of a select (at most one) or multiselect step.
 * `text`: the text step's answer, or the Other text of a choice step. `yes`: the confirm step's answer.
 */
const StepDraft = Type.Object({
  picked: Type.Array(Type.String()),
  text: Type.String(),
  yes: Type.Optional(Type.Boolean()),
});
type StepDraft = Static<typeof StepDraft>;
const Draft = Type.Object({ step: Type.Integer(), answers: Type.Array(StepDraft) });
type Draft = Static<typeof Draft>;

const draftKey = (id: string) => `pi-spore:question:${id}`;

const emptyDraft = (steps: QuestionStep[]): Draft => ({
  step: 0,
  answers: steps.map(() => ({ picked: [], text: "" })),
});

/** The stored draft, so a reload keeps the user's answers. A broken one is the user's own lost draft: start empty. */
function readDraft(question: Question): Draft {
  const empty = emptyDraft(question.steps);
  let stored: unknown;
  try {
    stored = JSON.parse(sessionStorage.getItem(draftKey(question.id)) ?? "null");
  } catch {
    return empty;
  }
  return Check(Draft, stored) &&
    stored.step >= 0 &&
    stored.step < question.steps.length &&
    stored.answers.length === question.steps.length
    ? stored
    : empty;
}

function isAnswered(step: QuestionStep, draft: StepDraft): boolean {
  if (step.type === "confirm") return draft.yes !== undefined;
  return draft.text.trim() !== "" || (step.type !== "text" && draft.picked.length > 0);
}

function toAnswer(step: QuestionStep, draft: StepDraft): StepAnswer {
  const other = draft.text.trim();
  switch (step.type) {
    case "text":
      return { type: "text", text: other };
    case "confirm":
      return { type: "confirm", yes: draft.yes === true };
    case "select":
      return draft.picked[0] !== undefined
        ? { type: "select", label: draft.picked[0] }
        : { type: "select", other };
    case "multiselect":
      return {
        type: "multiselect",
        labels: step.options
          .map((option) => option.label)
          .filter((label) => draft.picked.includes(label)),
        ...(other ? { other } : {}),
      };
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Ctrl+Enter or Cmd+Enter in a text box goes Next, as plain Enter types a new line. */
const isSubmitKey = (event: KeyboardEvent) =>
  event.key === "Enter" && (event.ctrlKey || event.metaKey);

/**
 * An open question on Home and in the chat panel, one step at a time (R3.5). Nothing reaches the agent until Submit,
 * which sends every step's answer in one request. `recommended` is advice only: it never picks for the user.
 */
export function QuestionCard({
  question,
  onError,
}: {
  question: Question;
  onError: (text: string) => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState(() => readDraft(question));
  const [sending, setSending] = useState(false);
  useEffect(
    () => sessionStorage.setItem(draftKey(question.id), JSON.stringify(draft)),
    [question.id, draft],
  );
  const { steps } = question;
  const index = draft.step;
  const step = steps[index] as QuestionStep;
  const current = draft.answers[index] as StepDraft;
  const last = index === steps.length - 1;
  const ready = isAnswered(step, current);
  // Updaters, so a pick and a Next from one key press both land.
  const change = (patch: Partial<StepDraft>) =>
    setDraft((old) => ({
      ...old,
      answers: old.answers.map((answer, at) =>
        at === old.step ? { ...answer, ...patch } : answer,
      ),
    }));
  const go = (to: number) => setDraft((old) => ({ ...old, step: to }));
  const back = () => {
    if (index > 0 && !sending) go(index - 1);
  };
  const next = (answered = ready) => {
    if (!last && answered && !sending) go(index + 1);
  };
  const submit = () => {
    setSending(true);
    const answers = steps.map((each, at) => toAnswer(each, draft.answers[at] as StepDraft));
    api.send("POST", `attention/questions/${question.id}/answer`, { answers }).then(
      () => sessionStorage.removeItem(draftKey(question.id)),
      (caught: unknown) => {
        onError(message(caught));
        setSending(false);
      },
    );
  };
  const onTextKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitKey(event)) {
      event.preventDefault();
      next();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape goes Back from anywhere in the card; the buttons do the same by click
    <div
      className="flex flex-col gap-2.5"
      onKeyDown={(event) => {
        if (event.key === "Escape") back();
      }}
    >
      {steps.length > 1 && (
        <span className="text-xs text-muted">
          Step {index + 1} of {steps.length}
        </span>
      )}
      <Markdown text={step.prompt} className="text-sm" />
      {step.type === "text" && (
        <Textarea
          value={current.text}
          onChange={(event) => change({ text: event.target.value })}
          onKeyDown={onTextKey}
          placeholder="Your answer"
          aria-label="Your answer"
          rows={2}
        />
      )}
      {step.type === "confirm" && (
        <div className="flex gap-2">
          {[true, false].map((yes) => (
            <Button
              key={String(yes)}
              aria-pressed={current.yes === yes}
              className={cn(current.yes === yes && "border-accent")}
              disabled={sending}
              onClick={() => change({ yes })}
            >
              {yes ? "Yes" : "No"}
              {step.recommended === yes && <Chip tone="accent">Recommended</Chip>}
            </Button>
          ))}
        </div>
      )}
      {(step.type === "select" || step.type === "multiselect") && (
        <ChoiceStep
          key={index}
          step={step}
          draft={current}
          disabled={sending}
          onChange={change}
          onEnter={next}
          onTextKey={onTextKey}
        />
      )}
      <div className="flex gap-2">
        {index > 0 && (
          <Button disabled={sending} onClick={back}>
            Back
          </Button>
        )}
        {last ? (
          <Button variant="primary" disabled={sending || !ready} onClick={submit}>
            Send answer
          </Button>
        ) : (
          <Button variant="primary" disabled={sending || !ready} onClick={() => next()}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}

/** A select or multiselect step: the option rows, the Other box, and the preview of the option in view. */
function ChoiceStep({
  step,
  draft,
  disabled,
  onChange,
  onEnter,
  onTextKey,
}: {
  step: Extract<QuestionStep, { type: "select" | "multiselect" }>;
  draft: StepDraft;
  disabled: boolean;
  onChange: (patch: Partial<StepDraft>) => void;
  /** Go Next; `answered` says whether the step now has an answer, as the draft is not updated yet. */
  onEnter: (answered: boolean) => void;
  onTextKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const multi = step.type === "multiselect";
  const labels = step.options.map((option) => option.label);
  const selected = labels.findIndex((label) => draft.picked.includes(label));
  const [focused, setFocused] = useState(selected === -1 ? 0 : selected);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  /** A select step's pick replaces the Other text; a multiselect box toggles and keeps it. */
  const pick = (at: number, toggle: boolean) => {
    setFocused(at);
    const label = labels[at] as string;
    if (!multi) return onChange({ picked: [label], text: "" });
    const has = draft.picked.includes(label);
    if (has && !toggle) return;
    onChange({
      picked: has ? draft.picked.filter((each) => each !== label) : [...draft.picked, label],
    });
  };
  const onKey = (event: KeyboardEvent) => {
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move !== 0) {
      event.preventDefault();
      const to = (focused + move + labels.length) % labels.length;
      setFocused(to);
      rows.current[to]?.focus();
      if (!multi) pick(to, false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(focused, false);
      onEnter(true);
    }
  };
  const shown: QuestionOption | undefined = multi
    ? step.options[focused]
    : step.options[selected === -1 ? (step.recommended ?? -1) : selected];
  const hasPreviews = step.options.some((option) => option.preview);
  return (
    <>
      <div
        className={cn(
          "flex flex-col gap-2.5",
          hasPreviews && "md:grid md:grid-cols-2 md:items-start",
        )}
      >
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole lint/a11y/noStaticElementInteractions: the role, chosen at run time, is group or radiogroup; both take a label and arrow keys */}
        <div
          role={multi ? "group" : "radiogroup"}
          aria-label="Options"
          className="flex flex-col gap-1.5"
          onKeyDown={onKey}
        >
          {step.options.map((option, at) => {
            const checked = draft.picked.includes(option.label);
            return (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role, chosen at run time, is checkbox or radio; both take aria-checked
              <button
                key={option.label}
                ref={(row) => {
                  rows.current[at] = row;
                }}
                type="button"
                role={multi ? "checkbox" : "radio"}
                aria-checked={checked}
                tabIndex={at === focused ? 0 : -1}
                disabled={disabled}
                onFocus={() => setFocused(at)}
                onClick={() => pick(at, true)}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-lg border bg-raised px-3 py-2 text-left text-sm text-fg disabled:cursor-default disabled:opacity-60",
                  checked
                    ? "border-accent ring-1 ring-accent"
                    : "border-line hover:border-accent/60",
                )}
              >
                <span className="flex items-baseline gap-2.5">
                  <span className="font-mono text-xs text-muted">{at + 1}</span>
                  <span className="min-w-0 flex-1">{option.label}</span>
                  {at === step.recommended && <Chip tone="accent">Recommended</Chip>}
                </span>
                {option.description && (
                  <Markdown text={option.description} className="text-xs text-muted" />
                )}
              </button>
            );
          })}
        </div>
        {shown?.preview && (
          <div className="rounded-lg border border-line bg-raised p-3 text-sm">
            <Markdown text={shown.preview} />
          </div>
        )}
      </div>
      {step.allowOther && (
        <Textarea
          value={draft.text}
          onChange={(event) =>
            onChange(
              multi ? { text: event.target.value } : { text: event.target.value, picked: [] },
            )
          }
          onKeyDown={onTextKey}
          placeholder="Or answer in your own words"
          aria-label="Or answer in your own words"
          rows={2}
        />
      )}
    </>
  );
}
