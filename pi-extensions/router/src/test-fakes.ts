import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RouterRequest } from "./router.js";

export const STRATA = "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs";
export const SONNET = "claude-bridge/claude-sonnet-5-5";
export const JEV = "openrouter/~typesafe/jev-latest";

/** A classifier result with these good-answer probabilities. */
export function jevResult(good: {
  bounded: number;
  explicit: number;
  visual: number;
  straightforward: number;
}) {
  const choice = (yes: string, no: string, p: number) => ({
    type: "choice",
    choice: p >= 0.5 ? yes : no,
    probabilities: { [yes]: p, [no]: 1 - p },
    confidence: Math.abs(2 * p - 1),
  });
  return {
    stopReason: "stop",
    answers: {
      bounded: choice("bounded", "open", good.bounded),
      explicit: choice("explicit", "vague", good.explicit),
      visual: choice("nonvisual", "visual", good.visual),
      straightforward: choice("straightforward", "hard", good.straightforward),
    },
  };
}

export const GOOD = { bounded: 0.97, explicit: 0.9, visual: 0.99, straightforward: 0.93 };

/** An extension context with a fake model registry and UI. The classifier answers with `classify`. */
export function fakeContext(
  cwd: string,
  options: {
    models?: string[];
    classifier?: boolean;
    classify?: () => unknown;
    sessionId?: string;
  } = {},
) {
  const notices: { message: string; type?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const classifyCalls: unknown[] = [];
  const models = new Map(
    (options.models ?? [STRATA, SONNET, "openai/gpt-6.1-terra"]).map((ref) => {
      const slash = ref.indexOf("/");
      return [ref, { provider: ref.slice(0, slash), id: ref.slice(slash + 1), api: "fake" }];
    }),
  );
  // SAFETY: the router only calls the members faked here (cwd, sessionManager ids, ui notify/setStatus, and the
  // registry's find, findOfType, and classify).
  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getSessionFile: () => `/sessions/${options.sessionId ?? "session-1"}.jsonl`,
    },
    ui: {
      notify: (message: string, type?: string) =>
        notices.push({ message, ...(type ? { type } : {}) }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
    modelRegistry: {
      find: (provider: string, id: string) => models.get(`${provider}/${id}`),
      findOfType: (_type: string, provider: string, id: string) =>
        options.classifier === false || `${provider}/${id}` !== JEV
          ? undefined
          : { provider, id, api: "typesafe-system-one" },
      classify: async (_model: unknown, context: unknown) => {
        classifyCalls.push(context);
        return (options.classify ?? (() => jevResult(GOOD)))();
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notices, statuses, classifyCalls };
}

export function userRequest(text: string, overrides: Partial<RouterRequest> = {}): RouterRequest {
  // SAFETY: the router reads only reason, thinkingLevel, messages, state, previous, failed, and signal.
  return {
    model: { provider: "spore", id: "auto" },
    thinkingLevel: "high",
    reason: "user",
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: text, timestamp: 0 },
    ],
    ...overrides,
  } as unknown as RouterRequest;
}
