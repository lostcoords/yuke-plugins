import type { SessionUpdate } from "yuke:protocol";
import { assertEquals, test } from "yuke:test";
import { Meter } from "../src/meter.ts";

const started = (draftId: string): SessionUpdate => ({ kind: "draftStarted", draftId });

function model(draftId: string, event: unknown): SessionUpdate {
  return { kind: "model", draftId, event } as SessionUpdate;
}

const block = (draftId: string, kind: string) =>
  model(draftId, { kind: "blockStarted", blockId: 0, content: { kind } });
const text = (draftId: string, value: string) => model(draftId, { kind: "textDelta", blockId: 0, text: value });
const completed = (draftId: string, output: number, reasoning?: number) =>
  model(draftId, {
    kind: "responseCompleted",
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: reasoning === undefined ? { output } : { output, reasoning },
  });

test("a completed answer gives its output tokens over the time from its first block, without the wait before it", () => {
  const meter = new Meter();
  meter.record(started("d1"), 0);
  // A thought that streams no text still starts the clock. Its tokens are in the output count.
  meter.record(block("d1", "reasoning"), 2000);
  meter.record(text("d1", "Hi"), 3000);
  meter.record(completed("d1", 400, 300), 6000);
  assertEquals(meter.text(6000), "100 tok/s");
  assertEquals(meter.streaming, false);
});

test("reasoning without a block runs before the first block, so its tokens leave the count", () => {
  const meter = new Meter();
  meter.record(started("d1"), 0);
  meter.record(block("d1", "text"), 5000);
  meter.record(completed("d1", 1100, 1000), 6000);
  assertEquals(meter.text(6000), "100 tok/s");
});

test("a streaming answer shows an estimate from its text after half a second, and keeps the last speed before", () => {
  const meter = new Meter();
  meter.record(started("d1"), 0);
  meter.record(block("d1", "text"), 0);
  meter.record(completed("d1", 100), 1000);
  meter.record(started("d2"), 2000);
  meter.record(block("d2", "text"), 2000);
  meter.record(text("d2", "a".repeat(200)), 2100);
  assertEquals([meter.streaming, meter.text(2400)], [true, "100 tok/s"]);
  meter.record(text("d2", "a".repeat(200)), 3000);
  // 400 characters are about 100 tokens, in one second of stream.
  assertEquals(meter.text(3100), "~100 tok/s");
});

test("a discarded draft, a short answer, and the events of another draft give no new speed", () => {
  const meter = new Meter();
  meter.record(started("d1"), 0);
  meter.record(block("d1", "text"), 0);
  meter.record(completed("d1", 50), 1000);
  meter.record(started("d2"), 2000);
  meter.record(text("d2", "a".repeat(400)), 2000);
  meter.record({ kind: "draftDiscarded", draftId: "d2", reason: "failed" }, 2200);
  assertEquals([meter.streaming, meter.text(3000)], [false, "50 tok/s"]);

  meter.record(started("d3"), 4000);
  meter.record(block("d3", "toolCall"), 4000);
  meter.record(completed("other", 1000), 4010);
  meter.record(completed("d3", 5), 4050);
  assertEquals(meter.text(4050), undefined);
});
