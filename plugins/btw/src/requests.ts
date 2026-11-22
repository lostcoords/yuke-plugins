import type { TextAnswer } from "yuke:ai";
import type { RoundBeforeEvent, SessionContext } from "yuke:plugins";
import type { ModelReference } from "yuke:protocol";

export const NO_ROUND = "Send a message in the main conversation before using /btw.";

/** The latest round of a session: the model it used, and a way to ask beside it. */
export interface Round {
  readonly sessionId: string;
  readonly model: ModelReference;
  /** Ask `question` against the round without changing its prompt, tools, settings, or context. */
  readonly ask: (question: string, signal: AbortSignal) => Promise<TextAnswer>;
}

// Keep one native snapshot per session, not a reconstructed prompt or the turn's cancellation signal.
const rounds = new Map<string, Round>();

export function session(context: SessionContext): () => void {
  const remember = (event: RoundBeforeEvent): undefined => {
    const sessionId = context.sessionId;
    rounds.set(sessionId, {
      sessionId,
      model: context.settings.model,
      ask: (question, signal) =>
        event.sideRequest({
          prompt: [
            "This is a separate side question about the conversation above. The main task continues independently.",
            "Answer only this question. Do not continue the main task. Do not call tools or change files.",
            "",
            question,
          ].join("\n"),
          signal: AbortSignal.any([signal, context.signal]),
        }),
    });
  };

  context.addHook("round.before", remember);
  context.addHook("round.retry", remember);

  return () => {
    rounds.delete(context.sessionId);
  };
}

/** The latest round of the session `sessionId`, or `undefined` before the first round of the session. */
export function latestRound(sessionId: string | undefined): Round | undefined {
  return sessionId === undefined ? undefined : rounds.get(sessionId);
}
