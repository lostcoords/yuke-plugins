import type { ModelReference, RoundBeforeEvent, SessionContext, SideRequestResult } from "yuke:plugins";

export const NO_ROUND = "Send a message in the main conversation before using /btw.";

type CachedRound = {
  request: RoundBeforeEvent["sideRequest"];
  signal: AbortSignal;
  model: ModelReference;
};

// Keep one native snapshot per session, not a reconstructed prompt or the turn's cancellation signal.
const rounds = new Map<string, CachedRound>();

export function session(context: SessionContext): () => void {
  const remember = (event: RoundBeforeEvent): undefined => {
    rounds.set(context.sessionId, {
      request: event.sideRequest,
      signal: context.signal,
      model: context.model,
    });
  };

  context.hook("round.before", remember);
  context.hook("round.retry", remember);

  return () => {
    rounds.delete(context.sessionId);
  };
}

/** Ask against the latest round without changing its prompt, tools, settings, or context. */
export async function ask(
  sessionId: string,
  question: string,
  signal: AbortSignal,
): Promise<SideRequestResult> {
  const round = rounds.get(sessionId);
  if (round === undefined) throw new Error(NO_ROUND);

  const prompt = question.trim();
  if (prompt === "") throw new Error("Enter a side question.");

  return round.request({
    prompt: [
      "This is a separate side question about the conversation above. The main task continues independently.",
      "Answer only this question. Do not continue the main task. Do not call tools or change files.",
      "",
      prompt,
    ].join("\n"),
    abortSignal: AbortSignal.any([signal, round.signal]),
  });
}

/** Read only the metadata needed by the UI; the native request stays owned here. */
export function cachedModel(sessionId: string | undefined): ModelReference | undefined {
  return sessionId === undefined ? undefined : rounds.get(sessionId)?.model;
}
