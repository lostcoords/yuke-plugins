import { assert, assertEquals, assertRejects, createHost, reply, test, waitForSettled } from "yuke:test";
import { session as setup } from "../src/index.ts";
import { latestRound } from "../src/requests.ts";
import { SPINNER_FRAME, scenario, waitForRequests } from "./support.ts";

const plugin = { name: "btw", session: setup };

/** Ask beside the latest round of a session, as the panel does. */
function ask(sessionId: string, question: string, signal: AbortSignal) {
  const round = latestRound(sessionId);
  assert(round !== undefined, "The session has no round.");
  return round.ask(question, signal);
}

test("a side answer arrives while the main model is still streaming and changes no main history", async () => {
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.stall("working"), reply.text("side answer"), reply.text("main continues")],
  });
  const main = await host.openSession();
  const controller = new AbortController();
  const running = main.sendMessage("main task", { signal: controller.signal }).catch(() => {});
  await waitForSettled();
  assert(main.transcript.entries.some((entry) => entry.kind === "text" && entry.text === "working"));
  const answer = await ask(main.id, "side question", new AbortController().signal);
  assertEquals(answer.text, "side answer");
  assertEquals(main.transcript.state, "running");
  assertEquals(host.requests.length, 2);
  assert(!JSON.stringify(main.transcript.entries).includes("side answer"));
  assert(!JSON.stringify(main.transcript.entries).includes("side question"));
  controller.abort();
  await running;
  await main.sendMessage("continue main");
  const messages = JSON.stringify(host.requests[2]?.messages);
  assert(messages.includes("main task"));
  assert(messages.includes("continue main"));
  assert(!messages.includes("side question"));
  assert(!messages.includes("side answer"));
});

test("a side request preserves the complete main request body except for an appended question", async () => {
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.text("main answer"), reply.text("side answer")],
  });
  const main = await host.openSession();
  await main.sendMessage("main task");
  await ask(main.id, "side question", new AbortController().signal);
  const expected = JSON.parse(JSON.stringify(host.requests[0]?.body));
  const actual = host.requests[1]?.body;
  assert(actual !== null && typeof actual === "object" && "messages" in actual);
  assert(Array.isArray(actual.messages));
  const side = actual.messages[actual.messages.length - 1];
  const added = side.content[side.content.length - 1];
  assert(added.text.endsWith("side question"));
  expected.messages[expected.messages.length - 1].content.push(added);
  assertEquals(actual, expected);
  assertEquals(host.requests[0]?.tools, host.requests[1]?.tools);
  assert((host.requests[0]?.tools.length ?? 0) > 0);
});

test("Anthropic keeps its cache marker on the original prefix, before the side question", async () => {
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.text("main answer"), reply.text("side answer")],
  });
  const main = await host.openSession({
    model: { provider: "anthropic", model: "claude-fable-5" },
  });
  await main.sendMessage("main task");
  await ask(main.id, "side question", new AbortController().signal);
  const mainBody = JSON.stringify(host.requests[0]?.body);
  const sideBody = JSON.stringify(host.requests[1]?.body);
  assert(mainBody.includes('"cache_control"'), mainBody);
  const expected = JSON.parse(mainBody);
  const side = JSON.parse(sideBody);
  assertEquals(side.messages[0].content[0].cache_control, { type: "ephemeral" });
  assertEquals(side.messages[0].content[0].text, "main task");
  const question = side.messages[side.messages.length - 1].content.at(-1);
  assert(!("cache_control" in question));
  expected.messages[expected.messages.length - 1].content.push(question);
  assertEquals(side, expected);
});

test("OpenAI keeps the session cache key and the original input prefix", async () => {
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.text("main answer"), reply.text("side answer")],
  });
  const main = await host.openSession({
    model: { provider: "openai", model: "gpt-4.1" },
  });
  await main.sendMessage("main task");
  await ask(main.id, "side question", new AbortController().signal);
  const before = JSON.parse(JSON.stringify(host.requests[0]?.body));
  const side = JSON.parse(JSON.stringify(host.requests[1]?.body));
  assertEquals(before.prompt_cache_key, main.id);
  assertEquals(side.prompt_cache_key, main.id);
  assert(Array.isArray(before.input));
  assert(Array.isArray(side.input));
  const last = side.input.at(-1);
  const question = last.content.at(-1);
  assert(question.text.endsWith("side question"));
  before.input.at(-1).content.push(question);
  assertEquals(side, before);
});

test("cancelling a side request leaves the main stream running", async () => {
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.stall("working"), reply.stall("side working")],
  });
  const main = await host.openSession();
  const mainController = new AbortController();
  const running = main.sendMessage("main task", { signal: mainController.signal }).catch(() => {});
  await waitForRequests(host, 1);
  const sideController = new AbortController();
  const side = ask(main.id, "side question", sideController.signal);
  await waitForRequests(host, 2);
  sideController.abort(new Error("side cancelled"));
  const error = await assertRejects(() => side);
  assert(error instanceof Error && error.message === "side cancelled");
  assertEquals(main.transcript.state, "running");
  mainController.abort();
  await running;
});

test("the latest round supplies the cache prefix and no side tool call is executed", async () => {
  let calls = 0;
  await using host = await createHost({
    plugins: [
      plugin,
      {
        name: "marker",
        session: (s) => {
          s.tools.add({
            name: "mark",
            description: "Mark a real tool run.",
            concurrency: "serial",
            inputSchema: { type: "object", properties: {} },
            execute: () => {
              calls++;
              return "marked";
            },
          });
        },
      },
    ],
    replies: [
      reply.toolCalls([{ name: "mark", args: {} }]),
      reply.text("first answer"),
      reply.text("second answer"),
      reply.toolCalls([{ name: "mark", args: {} }]),
    ],
  });
  const main = await host.openSession();
  await main.sendMessage("first task");
  assertEquals(calls, 1);
  await main.sendMessage("second task");
  const before = JSON.stringify(main.transcript.entries);
  const result = await ask(main.id, "side question", new AbortController().signal);
  assertEquals(result.finishReason, "toolCalls");
  assertEquals(calls, 1);
  assertEquals(JSON.stringify(main.transcript.entries), before);
  const side = JSON.stringify(host.requests[3]?.messages);
  assert(side.includes("first answer"));
  assert(side.includes("second task"));
  assert(!side.includes("second answer"));
});

test("closing a session cancels its side request", async () => {
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.text("main answer"), reply.stall("side working")],
  });
  const main = await host.openSession();
  await main.sendMessage("main task");
  const side = ask(main.id, "side question", new AbortController().signal);
  await waitForRequests(host, 2);
  const rejected = assertRejects(() => side);
  await main.close();
  await rejected;
});

test("cancelling the main turn does not cancel a side request", async () => {
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.stall("main working"), reply.stall("side working")],
  });
  const main = await host.openSession();
  const mainController = new AbortController();
  const running = main.sendMessage("main task", { signal: mainController.signal }).catch(() => {});
  await waitForRequests(host, 1);
  const sideController = new AbortController();
  let settled = false;
  const side = ask(main.id, "side question", sideController.signal).finally(() => {
    settled = true;
  });
  const rejected = assertRejects(() => side);
  await waitForRequests(host, 2);
  mainController.abort();
  await running;
  await waitForSettled();
  assertEquals(settled, false);
  sideController.abort();
  await rejected;
});

test("a compaction before the latest round becomes the side request's cached context", async () => {
  await using host = await createHost({
    plugins: [
      {
        name: "compact",
        session: (s) => {
          s.addHook("round.before", () => ({
            replace: { head: [{ kind: "userText", text: "compacted history" }], keep: 1 },
          }));
        },
      },
      plugin,
    ],
    replies: [reply.text("side answer")],
  });
  const main = await host.openSession();
  await main.runHook("round.before", {
    blocks: [
      { kind: "userText", text: "old input" },
      { kind: "assistantText", text: "old answer" },
      { kind: "userText", text: "new input" },
    ],
  });
  await ask(main.id, "side question", new AbortController().signal);
  const messages = JSON.stringify(host.requests[0]?.messages);
  assert(messages.includes("compacted history"));
  assert(messages.includes("new input"));
  assert(!messages.includes("old input"));
  assert(!messages.includes("old answer"));
});

test("repeated side questions reuse the original round without accumulating side context", async () => {
  const questions = ["first side question", "second side question", "third side question"];
  await using host = await createHost({
    plugins: [plugin],
    replies: [reply.text("main answer"), ...questions.map((question) => reply.text(`answer to ${question}`))],
  });
  const main = await host.openSession();
  await main.sendMessage("main task");
  const before = JSON.stringify(main.transcript.entries);
  for (const question of questions) {
    assertEquals((await ask(main.id, question, new AbortController().signal)).text, `answer to ${question}`);
    const expected = JSON.parse(JSON.stringify(host.requests[0]?.body));
    const actual = JSON.parse(JSON.stringify(host.requests.at(-1)?.body));
    const added = actual.messages.at(-1).content.at(-1);
    assert(added.text.endsWith(question));
    expected.messages.at(-1).content.push(added);
    assertEquals(actual, expected, "Each ask appends only its own prompt to the same native main-round request.");
    assertEquals(JSON.stringify(main.transcript.entries), before);
    assertEquals(main.transcript.state, "idle");
  }
  assertEquals(host.requests.length, 4);
});

test("closing a session discards its round", async () => {
  await using host = await createHost({ plugins: [plugin], replies: [reply.text("main answer")] });
  const main = await host.openSession();
  await main.sendMessage("main task");
  assert(latestRound(main.id) !== undefined);
  await main.close();
  assertEquals(latestRound(main.id), undefined);
});

scenario(
  "a side question runs beside the main turn, shows its progress, and leaves the main conversation alone",
  { width: 60, height: 24, replies: [reply.stall("working"), reply.text("A side answer.")] },
  async (s) => {
    const controller = new AbortController();
    const running = s.session.sendMessage("main task", { signal: controller.signal }).catch(() => {});
    await waitForRequests(s.host, 1);
    s.frame.key("ctrl+k b");
    assert(s.frame.rows().some((line) => line.includes("Ask a side question")));

    s.frame.paste("my side question");
    s.frame.key("enter");
    const pending = s.frame.rows();
    const status = pending.findIndex((line) => line.includes("Working…"));
    const composer = pending.findIndex((line) => line.includes("Ask a side question"));
    assertEquals(composer - status, 2, "The status belongs just above the composer.");
    const spinner = pending[status]?.match(SPINNER_FRAME)?.[0];
    assert(spinner !== undefined && pending[status]?.includes("0s"), pending.join("\n"));
    s.frame.advance(160);
    assert(!s.frame.rows()[status]?.includes(spinner), "The spinner advances.");
    s.frame.advance(1000);
    assert(s.frame.rows()[status]?.includes("1s"));

    s.frame.paste("my next draft");
    await waitForRequests(s.host, 2);
    const answered = s.frame.rows();
    const text = answered.join("\n");
    assert(text.indexOf("/btw my side question") < text.indexOf("A side answer."), text);
    assert(text.includes("main task"), "The main conversation stays visible above the panel.");
    assert(text.includes("my next draft"), "An arriving answer keeps the next draft.");
    assert(!SPINNER_FRAME.test(text), "The spinner stops with the answer.");
    s.frame.advance(2000);
    assertEquals(s.frame.rows(), answered);

    s.frame.key("ctrl+y");
    assertEquals(s.frame.copies, ["A side answer."]);
    assertEquals(s.session.transcript.state, "running");
    assert(!JSON.stringify(s.session.transcript.entries).includes("my side question"));
    s.frame.key("esc");
    assert(!s.frame.rows().join("\n").includes("A side answer."));
    controller.abort();
    await running;
  },
);

scenario(
  "an arriving answer does not steal the focus from the answer",
  { width: 60, height: 24, replies: [reply.text("main answer"), reply.text("the new side answer")] },
  async (s) => {
    await s.session.sendMessage("main task");
    s.frame.key("ctrl+k b");
    s.frame.paste("a side question");
    s.frame.key("enter");
    s.frame.paste("the next draft");
    s.frame.key("tab");
    await waitForRequests(s.host, 2);
    assert(s.frame.rows().join("\n").includes("the new side answer"));

    s.frame.paste(" lost");
    s.frame.key("tab");
    s.frame.paste("!");
    const text = s.frame.rows().join("\n");
    assert(text.includes("the next draft!"), text);
    assert(!text.includes("lost"), text);
  },
);

for (const draft of ["/btw", "/btw explain this side question"]) {
  scenario(
    `${draft} takes Enter before the main composer submits while its main turn streams`,
    {
      width: 80,
      height: 24,
      replies: [reply.stall("working on the main task"), reply.text("Answer to the side question.")],
    },
    async (s) => {
      const controller = new AbortController();
      const running = s.session.sendMessage("main task", { signal: controller.signal }).catch(() => {});
      await waitForRequests(s.host, 1);
      s.frame.paste(draft);
      s.frame.key("enter");
      if (draft === "/btw") {
        s.frame.paste("explain this side question");
        s.frame.key("enter");
      }
      await waitForRequests(s.host, 2);
      const text = s.frame.rows().join("\n");
      assert(text.indexOf("/btw explain this side question") < text.indexOf("Answer to the side question."), text);
      assert(s.host.requests[1]?.messages.at(-1)?.text.endsWith("explain this side question"));
      assertEquals(s.session.transcript.state, "running");
      assertEquals(s.session.transcript.pending.size, 0);

      s.frame.key("esc");
      const closed = s.frame.rows();
      assert(closed.includes("Message…"), closed.join("\n"));
      assert(!closed.join("\n").includes("Answer to the side question."));
      controller.abort();
      await running;
    },
  );
}

scenario("asking without a main round shows a notice and sends no request", { width: 60, height: 24 }, async (s) => {
  const notice = { level: "info", text: "Send a message in the main conversation before using /btw." };
  s.frame.paste("/btw side question");
  s.frame.key("enter");
  await waitForSettled();
  const kept = s.frame.rows();
  assert(
    kept.some((line) => line.includes("/btw side question")),
    "The refused command keeps its draft.",
  );
  assert(!kept.some((line) => line.includes("Ask a side question")), "No panel opens.");

  s.frame.key("ctrl+u");
  s.frame.key("ctrl+k b");
  s.frame.paste("typed in the panel");
  s.frame.key("enter");
  await waitForSettled();
  const panel = s.frame.rows();
  assert(
    panel.some((line) => line.includes("typed in the panel")),
    "The panel keeps its draft.",
  );
  assert(!panel.some((line) => line.includes("Working…")));
  assertEquals(
    s.host.notices.filter((item) => item.level === "info").map(({ level, text }) => ({ level, text })),
    [notice, notice],
  );
  assertEquals(s.host.requests.length, 0);
});

for (const outcome of ["error", "cancel"]) {
  scenario(
    `the spinner stops on ${outcome} without changing an idle main session`,
    {
      width: 60,
      height: 24,
      replies: [
        reply.text("main answer"),
        outcome === "error" ? reply.failed("partial answer") : reply.stall("partial answer"),
      ],
    },
    async (s) => {
      await s.session.sendMessage("main task");
      const before = JSON.stringify(s.session.transcript.entries);
      s.frame.key("ctrl+k b");
      s.frame.paste("side question");
      s.frame.key("enter");
      assert(SPINNER_FRAME.test(s.frame.rows().join("\n")));
      await waitForRequests(s.host, 2);
      if (outcome === "cancel") s.frame.key("esc");

      const stopped = s.frame.rows();
      const text = stopped.join("\n");
      assert(!SPINNER_FRAME.test(text), text);
      assert(text.includes("main task"), text);
      if (outcome === "error") {
        assert(text.includes("Side request failed"), text);
        assert(text.includes("/btw side question"), text);
        assert(text.includes("Ask a side question"), "The composer is empty again.");
      } else assert(!text.includes("/btw side question"), text);
      s.frame.advance(3000);
      assertEquals(s.frame.rows(), stopped);
      assertEquals(s.session.transcript.state, "idle");
      assertEquals(JSON.stringify(s.session.transcript.entries), before);
    },
  );
}
