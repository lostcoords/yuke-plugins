import type { Frozen } from "yuke:plugins";
import type { StoredEvent } from "yuke:protocol";
import { assertEquals, test } from "yuke:test";
import { costOf, tally } from "../src/tally.ts";

const settings = (seq: number, provider: string, model: string) =>
  ({ seq, kind: "settings", model: { provider, model } }) as unknown as Frozen<StoredEvent>;

function commit(seq: number, blocks: unknown[], usage?: Record<string, number>): Frozen<StoredEvent> {
  const answer = usage === undefined ? {} : { answer: { origin: {}, usage, finishReason: "stop" } };
  return { seq, kind: "commit", commit: { blocks, ...answer }, consumed: [] } as unknown as Frozen<StoredEvent>;
}

test("the cost prices fresh input, cache reads, text output, and reasoning output at their own prices", () => {
  const bands = [{ minPromptTokens: 0, input: 2, cacheRead: 0.5, output: 10, reasoning: 20 }];
  // 1M input of which 400k from the cache, 300k output of which 100k reasoning.
  const cost = costOf({ input: 1_000_000, cacheRead: 400_000, output: 300_000, reasoning: 100_000 }, bands);
  assertEquals(cost, 0.6 * 2 + 0.4 * 0.5 + 0.2 * 10 + 0.1 * 20);
});

test("the last band that the prompt reaches prices the whole request", () => {
  const bands = [
    { minPromptTokens: 0, input: 1, output: 1 },
    { minPromptTokens: 200_000, input: 2, output: 4 },
  ];
  assertEquals(costOf({ input: 100_000, output: 0 }, bands), 0.1);
  assertEquals(costOf({ input: 1_000_000, output: 1_000_000 }, bands), 2 + 4);
});

test("an answer that used a token kind without a price has no cost", () => {
  assertEquals(costOf({ input: 1000, cacheWrite: 10 }, [{ minPromptTokens: 0, input: 1 }]), undefined);
  assertEquals(costOf({ input: 1000 }, undefined), undefined);
});

test("each answer counts for the model of the settings before it, and an unpriced answer adds no cost", () => {
  const prices = new Map([["openai/a", [{ minPromptTokens: 0, input: 1, output: 1 }]]]);
  const usage = tally(
    [
      settings(1, "openai", "a"),
      commit(2, [], { input: 1_000_000, output: 0 }),
      settings(3, "local", "b"),
      commit(4, [], { input: 500, output: 200 }),
    ],
    prices,
  );
  assertEquals(usage.models.get("openai/a")?.cost, 1);
  assertEquals(usage.models.get("local/b")?.unpriced, 1);
  assertEquals(usage.totals.cost, 1);
  assertEquals(usage.totals.input, 1_000_500);
  assertEquals(usage.totals.answers, 2);
});

test("an error result counts against the tool of its call, also in a later commit", () => {
  const usage = tally(
    [
      commit(1, [
        { kind: "toolCall", callId: "c1", name: "exec", input: {} },
        { kind: "toolCall", callId: "c2", name: "read", input: {} },
      ]),
      commit(2, [
        { kind: "toolResult", callId: "c1", isError: true, content: [] },
        { kind: "toolResult", callId: "c2", isError: false, content: [] },
      ]),
    ],
    new Map(),
  );
  assertEquals(usage.tools.get("exec"), { calls: 1, errors: 1 });
  assertEquals(usage.tools.get("read"), { calls: 1, errors: 0 });
});
