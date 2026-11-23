import type { Frozen } from "yuke:plugins";
import type { PriceBand, StoredEvent, Usage } from "yuke:protocol";

/** The token counts and the estimated cost of a group of answers. */
export interface Totals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** The estimated cost in US dollars of the answers with known prices. */
  cost: number;
  answers: number;
  /** The answers whose model has no known price for a token kind that they used. */
  unpriced: number;
}

/** The calls of one tool. */
export interface ToolCount {
  calls: number;
  errors: number;
}

/** The usage of one session. */
export interface SessionUsage {
  readonly totals: Totals;
  /** The totals by `provider/model`. */
  readonly models: Map<string, Totals>;
  /** The calls by tool name. */
  readonly tools: Map<string, ToolCount>;
}

/** The prices of a model, by `provider/model`. */
export type Prices = ReadonlyMap<string, readonly Frozen<PriceBand>[]>;

export function emptyTotals(): Totals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, answers: 0, unpriced: 0 };
}

export function addTotals(into: Totals, from: Totals): void {
  into.input += from.input;
  into.output += from.output;
  into.reasoning += from.reasoning;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cost += from.cost;
  into.answers += from.answers;
  into.unpriced += from.unpriced;
}

/**
 * The cost in US dollars of `usage` with the price bands `bands`, or `undefined` when a used token kind has no price.
 * The last band that the prompt reaches prices the whole request. The input count holds the cached tokens.
 */
export function costOf(usage: Frozen<Usage>, bands: readonly Frozen<PriceBand>[] | undefined): number | undefined {
  const input = usage.input ?? 0;
  const band = bands?.findLast((candidate) => candidate.minPromptTokens <= input);
  if (band === undefined) return undefined;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const reasoning = usage.reasoning ?? 0;
  const parts: [number, number | undefined][] = [
    [input - cacheRead - cacheWrite, band.input],
    [cacheRead, band.cacheRead],
    [cacheWrite, band.cacheWrite],
    [(usage.output ?? 0) - reasoning, band.output],
    [reasoning, band.reasoning ?? band.output],
  ];
  let dollars = 0;
  for (const [tokens, price] of parts) {
    if (tokens <= 0) continue;
    if (price === undefined) return undefined;
    dollars += (tokens * price) / 1_000_000;
  }
  return dollars;
}

/**
 * The usage of the saved events of one session, in event order. An answer belongs to the model of the newest settings
 * event before it.
 */
export function tally(events: readonly Frozen<StoredEvent>[], prices: Prices): SessionUsage {
  const usage: SessionUsage = { totals: emptyTotals(), models: new Map(), tools: new Map() };
  let model = "unknown";
  // The name of each call, until its result comes.
  const calls = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "settings") {
      model = `${event.model.provider}/${event.model.model}`;
      continue;
    }
    for (const block of event.commit.blocks) {
      if (block.kind === "toolCall") {
        calls.set(block.callId, block.name);
        const count = usage.tools.get(block.name) ?? { calls: 0, errors: 0 };
        count.calls += 1;
        usage.tools.set(block.name, count);
      } else if (block.kind === "toolResult" && block.isError) {
        const name = calls.get(block.callId);
        const count = name === undefined ? undefined : usage.tools.get(name);
        if (count !== undefined) count.errors += 1;
      }
    }
    const answer = event.commit.answer;
    if (answer === undefined) continue;
    const totals: Totals = {
      input: answer.usage.input ?? 0,
      output: answer.usage.output ?? 0,
      reasoning: answer.usage.reasoning ?? 0,
      cacheRead: answer.usage.cacheRead ?? 0,
      cacheWrite: answer.usage.cacheWrite ?? 0,
      cost: 0,
      answers: 1,
      unpriced: 0,
    };
    const cost = costOf(answer.usage, prices.get(model));
    if (cost === undefined) totals.unpriced = 1;
    else totals.cost = cost;
    addTotals(usage.totals, totals);
    const byModel = usage.models.get(model) ?? emptyTotals();
    addTotals(byModel, totals);
    usage.models.set(model, byModel);
  }
  return usage;
}
