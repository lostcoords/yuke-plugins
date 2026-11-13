import { ChatCompletions, slashCompletions } from "yuke:chat";
import { assert, assertEquals, assertRejects, createFrame, createHost, reply, test, waitForSettled } from "yuke:test";
import { TextEditor } from "yuke:tui";
import { apply, session as setup } from "../src/index.ts";
import { ask } from "../src/requests.ts";
import { fakeChat, findRow, rows, rowText, screen, waitForRequests, withTerminal } from "./support.ts";

const plugin = { name: "btw", session: setup };

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
            parameters: { type: "object", properties: {} },
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

test("a session without a captured round refuses to send an uncached fallback request", async () => {
  await using host = await createHost({ plugins: [plugin] });
  const main = await host.openSession();
  const error = await assertRejects(() => ask(main.id, "side question", new AbortController().signal));
  assert(error instanceof Error && error.message === "Send a message in the main conversation before using /btw.");
  assertEquals(host.requests.length, 0);
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

for (const width of [32, 100]) {
  test(`the TUI command asks in parallel, copies its answer, and restores focus at width ${width}`, async () => {
    using frame = createFrame({ width, height: 30 });
    const surface = frame.surface("btw");
    let shown: string | undefined;
    await using host = await createHost({
      plugins: [
        fakeChat(() => shown),
        {
          name: "btw",
          uses: ["chat"],
          session: setup,
          apply: (ctx) => {
            return apply(withTerminal(ctx, surface.tui));
          },
        },
      ],
      replies: [reply.stall("working"), reply.text("A side answer.")],
    });
    const main = await host.openSession();
    shown = main.id;
    const controller = new AbortController();
    const running = main.sendMessage("main task", { signal: controller.signal }).catch(() => {});
    await waitForRequests(host, 1);
    surface.tui.panes.split(() => ({
      draw: (canvas) => canvas.text(0, 0, "MAIN WORK"),
    }));
    frame.draw();
    assertEquals(surface.tui.commands.run("btw:ask"), true);
    frame.draw();
    const initial = rows(frame);
    assert(
      initial.some((line) => line.includes("Ask a side question")),
      initial.join("\n"),
    );
    assert(!initial.some((line) => /cached round|latest main round|main task/i.test(line)));
    const titleRow = findRow(frame, " /btw ");
    assert(titleRow !== undefined);
    assertEquals(rowText(titleRow).trim(), "/btw", "The command belongs on a plain row, not in a border.");
    const titleColumn = titleRow.findIndex((cell) => cell.text === "b");
    assertEquals(titleRow[titleColumn]?.style.fg, "#a8cfa0", "Use Yuke's native accent for the title.");
    assertEquals(titleRow[titleColumn]?.style.bg, undefined, "Keep the terminal background throughout the panel.");
    const placeholderRow = findRow(frame, "Ask a side question");
    assert(placeholderRow !== undefined);
    const promptColumn = placeholderRow.findIndex((cell) => cell.text === "›");
    assertEquals(placeholderRow[promptColumn]?.style.bg, undefined, "The inset editor uses the terminal background.");
    assertEquals(placeholderRow[promptColumn - 2]?.style.bg, undefined, "Padding shares the same terminal background.");
    const input = surface.tui.widgets.list().find((mount) => mount.widget.kind === "editor")?.widget;
    assert(input?.kind === "editor");
    frame.paste("my side question");
    frame.key("shift+enter");
    assertEquals(input.state.text, "my side question\n");
    frame.key("enter");
    assertEquals(input.state.text, "", "Submitting a side question clears its composer immediately.");
    assertEquals(frame.frame.cursor?.row, frame.frame.height - 2, "Sending contracts the empty composer to one row.");
    const pendingRows = rows(frame);
    const pendingHeader = pendingRows.find((line) => line.includes("Working…"));
    assert(pendingHeader !== undefined);
    const spinner = pendingHeader.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)?.[0];
    assert(spinner !== undefined, "A pending side request must show an animated loading indicator.");
    assert(pendingHeader.includes("0s"), pendingHeader);
    const statusRow = pendingRows.findIndex((line) => line.includes("Working…"));
    const composerRow = pendingRows.findIndex((line) => line.includes("Ask a side question"));
    assertEquals(composerRow - statusRow, 2, "Loading belongs immediately above the composer.");
    assert(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(pendingRows.find((line) => line.includes(" /btw ")) ?? ""));
    frame.advance(160);
    const advancedHeader = rows(frame).find((line) => line.includes("Working…"));
    assert(advancedHeader !== undefined && !advancedHeader.includes(spinner), "The pending spinner must advance.");
    frame.advance(1000);
    assert(rows(frame).some((line) => line.includes("1s")));
    frame.paste("my next draft");
    // Request completion and the overlay's promise continuation run on later jobs.
    await waitForRequests(host, 2);
    const answered = screen(frame);
    assert(answered.includes("A side answer."), answered);
    assert(answered.includes("/btw my side question"), answered);
    const questionRow = findRow(frame, "/btw my side question");
    assert(questionRow !== undefined);
    const questionColumn = questionRow.findIndex((cell) => cell.text === "/");
    assertEquals(questionRow[questionColumn]?.style.bg, undefined, "Native text views retain the terminal background.");
    const answerRow = findRow(frame, "A side answer.");
    assert(answerRow !== undefined);
    assertEquals(answerRow.find((cell) => cell.text === "A")?.style.fg, undefined);
    assert(!answered.split("\n").some((line) => ["You", "Yuke"].includes(line.trim())), answered);
    assert(!/cached round|asking in parallel|main task is still running/.test(answered), answered);
    const finishedHeader = answered.split("\n").find((line) => line.includes(" /btw "));
    assert(finishedHeader !== undefined && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(finishedHeader));
    frame.advance(2000);
    assertEquals(screen(frame), answered, "Loading must stop after the answer arrives.");
    assert(answered.includes("A side answer."), answered);
    assert(answered.indexOf("my side question") < answered.indexOf("A side answer."), answered);
    assertEquals(surface.tui.focused, input);
    assertEquals(input.state.text, "my next draft", "An arriving answer must preserve the next draft.");
    assert(answered.includes("MAIN WORK"), answered);
    frame.key("ctrl+y");
    assertEquals(frame.copies, ["A side answer."]);
    assertEquals(main.transcript.state, "running");
    frame.key("esc");
    assert(!screen(frame).includes("A side answer."));
    controller.abort();
    await running;
  });
}

for (const draft of ["/btw", "/btw explain this side question"]) {
  test(`${draft} takes Enter before the main composer submits while its main turn streams`, async () => {
    using frame = createFrame({ width: 80, height: 24 });
    const surface = frame.surface("btw");
    let shown: string | undefined;
    const submissions: string[] = [];
    const composer = new TextEditor({
      role: "composer",
      onSubmit: (state) => {
        submissions.push(state.text);
      },
    });
    await using host = await createHost({
      plugins: [
        fakeChat(() => shown),
        {
          name: "btw",
          uses: ["chat"],
          session: setup,
          apply: (ctx) => apply(withTerminal(ctx, surface.tui)),
        },
      ],
      replies: [reply.stall("working on the main task"), reply.text("Answer to the side question.")],
    });
    const main = await host.openSession();
    shown = main.id;
    const controller = new AbortController();
    const running = main.sendMessage("main task", { signal: controller.signal }).catch(() => {});
    await waitForRequests(host, 1);
    new ChatCompletions(composer, {
      providers: () => [slashCompletions(surface.tui.commands)],
      cwd: () => "/",
      signal: controller.signal,
      enabled: () => true,
      onChange: () => {},
      onError: (error) => {
        throw error;
      },
    });
    surface.tui.panes.split(() => ({
      initialFocus: composer,
      draw() {},
      layout: (size) => [
        {
          view: composer,
          rect: { column: 0, row: 0, width: size.width, height: 1 },
        },
      ],
    }));
    frame.draw();
    frame.paste("ordinary main message");
    frame.key("enter");
    assertEquals(submissions, ["ordinary main message"]);
    composer.replace(0, composer.state.text.length, draft);
    frame.key("enter");
    if (draft === "/btw") {
      frame.paste("explain this side question");
      frame.key("enter");
    }
    await waitForRequests(host, 2);
    const answered = screen(frame);
    assert(answered.includes("Answer to the side question."), answered);
    assertEquals(submissions, ["ordinary main message"]);
    assertEquals(main.transcript.state, "running");
    assertEquals(main.transcript.pending.size, 0);
    assertEquals(composer.state.text, "");
    const sideInput = surface.tui.widgets.list().find((mount) => mount.widget.role === "field")?.widget;
    assert(sideInput?.kind === "editor");
    assertEquals(sideInput.state.text, "", "Both /btw entry paths leave the side composer empty.");
    assert(answered.indexOf("explain this side question") < answered.indexOf("Answer to the side question."), answered);
    frame.key("esc");
    assertEquals(surface.tui.focused, composer);
    controller.abort();
    await running;
  });
}

test("the installed manifest loads against Yuke's plugin loader", async () => {
  const directory = import.meta.dirname;
  assert(directory !== undefined, "This test must run from a file.");
  const folder = `${directory}/..`;
  await using host = await createHost({
    plugins: [fakeChat(), { folder }],
    replies: [reply.text("main answer"), reply.text("side answer")],
  });
  const main = await host.openSession();
  await main.sendMessage("main task");
  assertEquals((await ask(main.id, "side question", new AbortController().signal)).text, "side answer");
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

test("an empty side question sends no request", async () => {
  await using host = await createHost({ plugins: [plugin], replies: [reply.text("main answer")] });
  const main = await host.openSession();
  await main.sendMessage("main task");
  const error = await assertRejects(() => ask(main.id, "   ", new AbortController().signal));
  assert(error instanceof Error && error.message === "Enter a side question.");
  assertEquals(host.requests.length, 1);
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

for (const outcome of ["error", "cancel"]) {
  test(`the loading indicator stops on ${outcome} without changing an idle main session`, async () => {
    using frame = createFrame({ width: 48, height: 20 });
    const surface = frame.surface("btw");
    let shown: string | undefined;
    await using host = await createHost({
      plugins: [
        fakeChat(() => shown),
        {
          name: "btw",
          uses: ["chat"],
          session: setup,
          apply: (ctx) => apply(withTerminal(ctx, surface.tui)),
        },
      ],
      replies: [
        reply.text("main answer"),
        outcome === "error" ? reply.failed("partial answer") : reply.stall("partial answer"),
      ],
    });
    const main = await host.openSession();
    shown = main.id;
    await main.sendMessage("main task");
    const before = JSON.stringify(main.transcript.entries);
    surface.tui.panes.split(() => ({ draw: (canvas) => canvas.text(0, 0, "MAIN READY") }));
    surface.tui.commands.run("btw:ask");
    frame.draw();
    frame.paste("side question");
    frame.key("enter");
    assert(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(screen(frame)));
    await waitForRequests(host, 2);
    if (outcome === "cancel") frame.key("esc");
    const stopped = screen(frame);
    assert(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(stopped));
    assert(stopped.includes("MAIN READY"));
    if (outcome === "error") {
      assert(stopped.includes("Side request failed"), stopped);
      assert(stopped.includes("/btw side question"));
      const editor = surface.tui.widgets.list().find((mount) => mount.widget === surface.tui.focused)?.widget;
      assert(editor?.kind === "editor");
      assertEquals(editor.state.text, "");
    } else assert(!stopped.includes(" /btw "));
    frame.advance(3000);
    assertEquals(screen(frame), stopped);
    assertEquals(main.transcript.state, "idle");
    assertEquals(JSON.stringify(main.transcript.entries), before);
  });
}

test("closing the parent session discards its cached side-request handle", async () => {
  await using host = await createHost({ plugins: [plugin], replies: [reply.text("main answer")] });
  const main = await host.openSession();
  await main.sendMessage("main task");
  await main.close();
  const error = await assertRejects(() => ask(main.id, "a stale side question", new AbortController().signal));
  assert(error instanceof Error && error.message === "Send a message in the main conversation before using /btw.");
  const fresh = await host.openSession();
  const missing = await assertRejects(() => ask(fresh.id, "another question", new AbortController().signal));
  assert(missing instanceof Error && missing.message === "Send a message in the main conversation before using /btw.");
  assertEquals(host.requests.length, 1, "A closed session's snapshot cannot send or leak into another session.");
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
