import { mkdir, writeTextFile } from "yuke:fs";
import {
  assert,
  assertEquals,
  createFrame,
  createHost,
  type FrameTest,
  type Reply,
  reply,
  test,
  waitForSettled,
} from "yuke:test";
import { History } from "../src/history.ts";
import { apply, session } from "../src/index.ts";
import { fakeChat, findRow, rowText, screen, waitForScreen, withTerminal } from "./support.ts";

async function setup(frame: FrameTest, replies: readonly Reply[] = []) {
  const surface = frame.surface("btw");
  let shown: string | undefined;
  let dataDir: string | undefined;
  const host = await createHost({
    plugins: [
      fakeChat(() => shown),
      {
        name: "btw",
        uses: ["chat"],
        session,
        apply: (ctx) => {
          dataDir = ctx.dataDir;
          return apply(withTerminal(ctx, surface.tui));
        },
      },
    ],
    replies,
  });
  const main = await host.openSession();
  shown = main.id;
  assert(dataDir !== undefined);
  const history = new History(dataDir);
  surface.tui.panes.split(() => ({ draw: (canvas) => canvas.text(0, 0, "MAIN") }));
  frame.draw();
  return { host, main, history, tui: surface.tui, dataDir };
}

const record = {
  model: { provider: "provider", model: "model" },
  question: "earlier question",
  answer: "earlier answer",
};

for (const width of [32, 100]) {
  test(`saved answers can be reopened and copied without a cached main round at width ${width}`, async () => {
    using frame = createFrame({ width, height: 30 });
    const loaded = await setup(frame);
    await using host = loaded.host;
    await loaded.history.save({ ...record, sessionId: loaded.main.id });
    loaded.tui.commands.run("btw:ask");
    await waitForScreen(frame, "earlier answer");
    assert(!screen(frame).includes("History ·"));
    const header = screen(frame)
      .split("\n")
      .find((line) => line.trim().startsWith("/btw "));
    assert(header !== undefined, "Saved answers use the same command/question heading without a timestamp.");
    const editor = loaded.tui.widgets.list().find((mount) => mount.widget === loaded.tui.focused)?.widget;
    assert(editor?.kind === "editor");
    assertEquals(editor.state.text, "");
    frame.key("ctrl+y");
    assertEquals(frame.copies, ["earlier answer"]);
    frame.key("esc");
    loaded.tui.commands.run("btw:ask");
    await waitForScreen(frame, "earlier answer");
    assertEquals(host.requests.length, 0);
    assertEquals(loaded.main.transcript.entries.length, 0);
  });
}

test("a tool-call response copies the same displayed answer before and after reopening history", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.toolCalls([{ name: "mark", args: {} }])]);
  await using host = loaded.host;
  await loaded.main.sendMessage("main task");

  loaded.tui.commands.run("btw:ask");
  frame.paste("side question");
  frame.key("enter");
  const notice = "[Response ended: toolCalls. No tool was executed.]";
  await waitForScreen(frame, notice);

  const expected = `The model returned no text. No tool was executed.\n\n${notice}`;
  const saved = (await loaded.history.list(loaded.main.id)).entries[0];
  assertEquals(saved?.answer, expected);
  frame.key("ctrl+y");
  assertEquals(frame.copies, [expected]);

  frame.key("esc");
  loaded.tui.commands.run("btw:history");
  await waitForScreen(frame, "side question");
  frame.key("enter");
  await waitForScreen(frame, notice);
  frame.key("ctrl+y");
  assertEquals(frame.copies, [expected, expected]);
  assertEquals(host.requests.length, 2);
});

test("asking without a main round shows an info notice and sends no request", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;

  loaded.tui.commands.run("btw:ask");
  frame.paste("side question");
  frame.key("enter");
  await waitForSettled();
  assertEquals(
    host.notices.map(({ level, text: message }) => ({ level, message })),
    [{ level: "info", message: "Send a message in the main conversation before using /btw." }],
  );
  assertEquals(host.requests.length, 0);
});

test("history search finds answer text and can browse other sessions without a model call", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  await loaded.history.save({ ...record, sessionId: loaded.main.id });
  await loaded.history.save({
    ...record,
    question: "different question",
    answer: "searchable answer needle",
    sessionId: "other-session",
  });
  loaded.tui.commands.run("btw:history");
  await waitForScreen(frame, "earlier question");
  assert(screen(frame).includes("this session"));
  assert(!/\d{4}-\d{2}-\d{2}/.test(screen(frame)), "Keep dates out of the history UI.");
  const pickerTitle = findRow(frame, "btw history");
  assert(pickerTitle !== undefined);
  assertEquals(pickerTitle.find((cell) => cell.text === "b")?.style.bg, undefined);
  const selectedRow = findRow(frame, "earlier question");
  assert(selectedRow !== undefined);
  const selectedCell = selectedRow.find((cell) => cell.text === "e");
  assert(selectedCell?.style.bg !== undefined, "Native selection highlighting stays visible on the panel.");
  assert(!screen(frame).includes("different question"));
  frame.key("tab");
  await waitForScreen(frame, "different question");
  frame.paste("needle");
  assert(!screen(frame).includes("earlier question"));
  frame.key("enter");
  await waitForScreen(frame, "searchable answer needle");
  assert(!screen(frame).includes("History ·"));
  const header = screen(frame)
    .split("\n")
    .find((line) => line.trim().startsWith("/btw "));
  assert(header !== undefined, "Saved answers use the same command/question heading without a timestamp.");
  assertEquals(host.requests.length, 0);
});

test("a new question after browsing does not send saved questions or answers to the model", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.text("new side answer")]);
  await using host = loaded.host;
  await loaded.main.sendMessage("main task");
  await loaded.history.save({ ...record, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:ask");
  await waitForScreen(frame, "earlier answer");
  frame.paste("an independent new question");
  frame.key("enter");
  await waitForScreen(frame, "new side answer");
  const sent = JSON.stringify(host.requests[1]?.messages);
  assert(sent.includes("an independent new question"));
  assert(!sent.includes("earlier question"));
  assert(!sent.includes("earlier answer"));
  assertEquals((await loaded.history.list(loaded.main.id)).entries.length, 2);
  frame.key("esc");
  loaded.tui.commands.run("btw:ask");
  await waitForScreen(frame, "new side answer");
  assertEquals(host.requests.length, 2);
});

test("history deletion requires explicit confirmation and respects the session scope", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  await loaded.history.save({ ...record, sessionId: loaded.main.id });
  await loaded.history.save({ ...record, sessionId: "other-session", question: "other question" });
  loaded.tui.commands.run("btw:history");
  await waitForScreen(frame, "earlier question");
  frame.key("tab");
  frame.key("ctrl+x");
  assert(!screen(frame).includes("Type DELETE"), "A scope that is still loading must not delete stale entries.");
  await waitForScreen(frame, "other question");
  frame.key("tab");
  await waitForScreen(frame, "earlier question");
  frame.key("ctrl+x");
  assert(screen(frame).includes("Type DELETE"));
  const confirmTitle = findRow(frame, "Delete 1 saved");
  assert(confirmTitle !== undefined);
  assertEquals(confirmTitle.find((cell) => cell.text === "D")?.style.bg, undefined);
  const confirmInput = findRow(frame, "Type DELETE");
  assert(confirmInput !== undefined);
  assertEquals(confirmInput.find((cell) => cell.text === "T")?.style.bg, undefined);
  frame.key("enter");
  assertEquals((await loaded.history.list()).entries.length, 2);
  frame.key("esc");
  frame.key("ctrl+d");
  frame.paste("DELETE");
  frame.key("enter");
  await waitForScreen(frame, "No saved answers");
  assertEquals(
    (await loaded.history.list()).entries.map((item) => item.question),
    ["other question"],
  );
  frame.key("tab");
  await waitForScreen(frame, "other question");
  frame.key("ctrl+x");
  frame.paste("DELETE");
  frame.key("enter");
  await waitForScreen(frame, "No saved answers");
  assertEquals((await loaded.history.list()).entries, []);
  assertEquals(host.requests.length, 0);
});

test("a narrow confirmation rejects lowercase input and Esc returns to history", async () => {
  using frame = createFrame({ width: 32, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  await loaded.history.save({ ...record, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:history");
  await waitForScreen(frame, "earlier question");

  frame.key("ctrl+d");
  frame.paste("delete");
  frame.key("enter");
  assert(screen(frame).includes("Delete 1 saved"));
  assertEquals((await loaded.history.list()).entries.length, 1);

  frame.key("esc");
  assert(!screen(frame).includes("Type DELETE"));
  assert(screen(frame).includes("btw history"));
});

test("storage failure preserves the answer and reports that it was not saved", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.text("do not lose this answer")]);
  await using host = loaded.host;
  await loaded.main.sendMessage("main task");
  await mkdir(`${loaded.dataDir}/history`);
  await writeTextFile(`history/${loaded.main.id}`, "not a directory", { cwd: loaded.dataDir });
  loaded.tui.commands.run("btw:ask");
  frame.draw();
  frame.paste("side question");
  frame.key("enter");
  await waitForScreen(frame, "do not lose this answer");
  assert(host.notices.some((notice) => notice.text.includes("was not saved")));
  frame.key("ctrl+y");
  assertEquals(frame.copies, ["do not lose this answer"]);
});

test("flat presentation preserves Markdown highlights and copying the original answer", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  loaded.tui.styles.add({
    "markdown.strong": { bold: true },
    "markdown.code": { fg: "warn" },
  });
  const answer = "Use **bold** and `inline`.";
  await loaded.history.save({ ...record, answer, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:ask");
  await waitForScreen(frame, "Use bold and inline.");
  const row = findRow(frame, "Use bold and inline.");
  assert(row !== undefined);
  const text = rowText(row);
  assertEquals(row[text.indexOf("bold")]?.style.bold, true);
  assertEquals(row[text.indexOf("inline")]?.style.fg, "#e3b341");
  assertEquals(row[text.indexOf("inline")]?.style.bg, undefined);
  frame.key("ctrl+y");
  assertEquals(frame.copies, [answer]);
  assertEquals(host.requests.length, 0);
});

test("long multiline questions wrap without losing text or replacing the answer", async () => {
  using frame = createFrame({ width: 32, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  const question = "first line with enough words to wrap across the narrow terminal\nlast line 界";
  const answer = "An independent answer.";
  await loaded.history.save({ ...record, question, answer, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:ask");
  await waitForScreen(frame, answer);
  for (const width of [32, 100]) {
    frame.resize({ width, height: 30 });
    const lines = screen(frame).split("\n");
    const start = lines.findIndex((line) => line.includes("/btw"));
    const end = lines.findIndex((line, i) => i > start && line.trim() === "");
    assert(start >= 0 && end > start + 1, "The multiline question must remain visible across rows.");
    assertEquals(
      lines.slice(start, end).join(" ").trim().replaceAll(/\s+/g, " "),
      `/btw ${question}`.replaceAll(/\s+/g, " "),
    );
    assert(lines.some((line) => line.includes(answer)));
    const continuation = frame.frame.cells[start + 1];
    assert(continuation !== undefined);
    assertEquals(continuation.find((cell) => cell.text.trim() !== "")?.style.dim, true);
  }
  frame.key("ctrl+y");
  assertEquals(frame.copies, [answer]);
  assertEquals(host.requests.length, 0);
});

test("an arriving answer preserves output focus and the next independent draft", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.text("the new side answer")]);
  await using host = loaded.host;
  await loaded.main.sendMessage("main task");

  loaded.tui.commands.run("btw:ask");
  frame.draw();
  const editor = loaded.tui.widgets.list().find((mount) => mount.widget === loaded.tui.focused)?.widget;
  assert(editor?.kind === "editor");

  frame.paste("a side question");
  frame.key("enter");
  frame.paste("the next independent draft");
  frame.key("tab");
  const output = loaded.tui.focused;
  assert(output !== undefined && output !== editor);

  await waitForScreen(frame, "the new side answer");
  assertEquals(loaded.tui.focused, output, "Request completion must not steal focus back from the answer.");
  assertEquals(editor.state.text, "the next independent draft");

  frame.key("ctrl+y");
  assertEquals(frame.copies, ["the new side answer"]);
  frame.key("tab");
  assertEquals(loaded.tui.focused, editor);
  assertEquals(editor.state.text, "the next independent draft");
  assertEquals(host.requests.length, 2);
});
