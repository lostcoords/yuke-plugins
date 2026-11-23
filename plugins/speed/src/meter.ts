import type { Frozen } from "yuke:plugins";
import type { SessionUpdate } from "yuke:protocol";

/** A live estimate needs this much streamed time, so the first deltas do not give a wild number. */
const ESTIMATE_MS = 500;

/** A shorter answer gives no speed, because its time is mostly the cost of the request. */
const MEASURE_MS = 100;

/** The facts of one answer of the model. Each time is on the clock of the caller, in milliseconds. */
interface Answer {
  readonly draftId: string;
  /** The start of the first block: the model starts to generate, also for a thought that streams no text. */
  started: number | undefined;
  /** A reasoning block started, so its time is in the measure. */
  reasoned: boolean;
  /** The first streamed text, the start of the live estimate. */
  firstDelta: number | undefined;
  /** The streamed characters. About four make a token. */
  characters: number;
  /** The end of the answer, with its output tokens. */
  completed: { readonly at: number; readonly tokens: number } | undefined;
}

/**
 * The output speed of the answers of one session. An answer that completed gives its output tokens over the time from
 * its first block to its end, so the wait before the first token does not count. The output tokens hold the reasoning
 * tokens. Reasoning that streams no block runs before the first block, so its tokens do not count.
 * An answer that streams gives an estimate from its text.
 */
export class Meter {
  #current: Answer | undefined;
  #last: Answer | undefined;

  /** Take `update` of the session at the time `now`. */
  record(update: Frozen<SessionUpdate>, now: number): void {
    if (update.kind === "draftStarted") {
      this.#current = {
        draftId: update.draftId,
        started: undefined,
        reasoned: false,
        firstDelta: undefined,
        characters: 0,
        completed: undefined,
      };
      return;
    }
    const answer = this.#current;
    if (answer === undefined) return;
    if (update.kind === "draftDiscarded" && update.draftId === answer.draftId) {
      this.#current = undefined;
      return;
    }
    if (update.kind !== "model" || update.draftId !== answer.draftId) return;
    const event = update.event;
    switch (event.kind) {
      case "blockStarted":
        answer.started ??= now;
        if (event.content.kind === "reasoning") answer.reasoned = true;
        break;
      case "textDelta":
      case "reasoningDelta":
      case "refusalDelta":
      case "toolInputDelta":
        answer.firstDelta ??= now;
        answer.characters += event.text.length;
        break;
      case "responseCompleted":
        if (answer.started !== undefined && event.usage.output !== undefined) {
          // Hidden reasoning runs before the first block, so its tokens leave the count when its time is not measured.
          const hidden = answer.reasoned ? 0 : (event.usage.reasoning ?? 0);
          answer.completed = { at: now, tokens: event.usage.output - hidden };
        }
        this.#last = answer;
        this.#current = undefined;
        break;
    }
  }

  /** Whether an answer streams now, so its estimate changes with time. */
  get streaming(): boolean {
    return this.#current !== undefined;
  }

  /** The text of the status bar at the time `now`: `~42 tok/s` for an estimate, or `undefined` without a speed. */
  text(now: number): string | undefined {
    const current = this.#current;
    if (current?.firstDelta !== undefined && now - current.firstDelta >= ESTIMATE_MS) {
      return `~${Math.round((current.characters * 1000) / 4 / (now - current.firstDelta))} tok/s`;
    }
    const last = this.#last;
    if (last?.completed === undefined || last.started === undefined) return undefined;
    const ms = last.completed.at - last.started;
    if (ms < MEASURE_MS || last.completed.tokens === 0) return undefined;
    return `${Math.round((last.completed.tokens * 1000) / ms)} tok/s`;
  }
}
