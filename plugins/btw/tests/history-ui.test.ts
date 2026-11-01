import { mkdir, writeTextFile } from "yuke:fs";
import type { PluginContext, ServiceOf, Services } from "yuke:plugins";
import { assert, createFrame, createHost, equal, type FrameTest, type Reply, reply, test } from "yuke:test";
import { History } from "../src/history.ts";
import { apply, session } from "../src/index.ts";

async function waitFor(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries === 200) throw new Error("Expected UI state did not arrive.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function screen(frame: FrameTest): string {
  frame.draw();
  return frame.frame.cells.map((row) => row.map((cell) => cell.text).join("")).join("\n");
}

async function setup(frame: FrameTest, replies: readonly Reply[] = []) {
  const surface = frame.surface("btw");
  surface.tui.styles.set("chat.title", { fg: "accent", bold: true });
  surface.tui.styles.set("chat.hint", { fg: "accent" });
  surface.tui.styles.set("chat.meta", { dim: true });
  let shown: string | undefined;
  let dataDir: string | undefined;
  const host = await createHost({
    plugins: [
      {
        name: "chat",
        provides: ["chat"],
        apply: (ctx) => {
          ctx.provide("chat", { session: () => shown, show: async () => {}, onChange: () => () => {} });
        },
      },
      {
        name: "btw",
        uses: ["chat"],
        session,
        apply: (ctx) => {
          dataDir = ctx.dataDir;
          const get = <K extends keyof Services & string>(name: K): ServiceOf<K> =>
            name === "tui" ? (surface.tui as ServiceOf<K>) : ctx.get(name);
          return apply({ ...ctx, get } satisfies PluginContext);
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
    await waitFor(() => screen(frame).includes("earlier answer"));
    assert(!screen(frame).includes("History ·"));
    const header = screen(frame)
      .split("\n")
      .find((line) => line.trim().startsWith("/btw "));
    assert(header !== undefined, "Saved answers use the same command/question heading without a timestamp.");
    const editor = loaded.tui.widgets.list().find((mount) => mount.widget === loaded.tui.focused)?.widget;
    assert(editor?.kind === "editor");
    equal(editor.state.text, "");
    frame.key("ctrl+y");
    equal(frame.copies, ["earlier answer"]);
    frame.key("esc");
    loaded.tui.commands.run("btw:ask");
    await waitFor(() => screen(frame).includes("earlier answer"));
    equal(host.requests.length, 0);
    equal(loaded.main.transcript.entries.length, 0);
  });
}

test("a tool-call response copies the same displayed answer before and after reopening history", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.toolCall("mark", {})]);
  await using host = loaded.host;
  await loaded.main.send("main task");

  loaded.tui.commands.run("btw:ask");
  frame.paste("side question");
  frame.key("enter");
  const notice = "[Response ended: tool_calls. No tool was executed.]";
  await waitFor(() => screen(frame).includes(notice));

  const expected = `The model returned no text. No tool was executed.\n\n${notice}`;
  const saved = (await loaded.history.list(loaded.main.id)).entries[0];
  equal(saved?.answer, expected);
  frame.key("ctrl+y");
  equal(frame.copies, [expected]);

  frame.key("esc");
  loaded.tui.commands.run("btw:history");
  await waitFor(() => screen(frame).includes("side question"));
  frame.key("enter");
  await waitFor(() => screen(frame).includes(notice));
  frame.key("ctrl+y");
  equal(frame.copies, [expected, expected]);
  equal(host.requests.length, 2);
});

test("asking without a main round shows an info notice and sends no request", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;

  loaded.tui.commands.run("btw:ask");
  frame.paste("side question");
  frame.key("enter");
  await waitFor(() => host.notices.length > 0);
  equal(host.notices.map(({ level, message }) => ({ level, message })), [
    { level: "info", message: "Send a message in the main conversation before using /btw." },
  ]);
  equal(host.requests.length, 0);
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
  await waitFor(() => screen(frame).includes("earlier question"));
  assert(screen(frame).includes("this session"));
  assert(!/\d{4}-\d{2}-\d{2}/.test(screen(frame)), "Keep dates out of the history UI.");
  const pickerTitle = frame.frame.cells.find((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .includes("btw history"),
  );
  assert(pickerTitle !== undefined);
  equal(pickerTitle.find((cell) => cell.text === "b")?.style.bg, undefined);
  const selectedRow = frame.frame.cells.find((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .includes("earlier question"),
  );
  assert(selectedRow !== undefined);
  const selectedCell = selectedRow.find((cell) => cell.text === "e");
  equal(selectedCell?.style.bg, undefined);
  equal(selectedCell?.style.reverse, true, "Native selection highlighting stays visible on the panel.");
  assert(!screen(frame).includes("different question"));
  frame.key("tab");
  await waitFor(() => screen(frame).includes("different question"));
  frame.paste("needle");
  assert(!screen(frame).includes("earlier question"));
  frame.key("enter");
  await waitFor(() => screen(frame).includes("searchable answer needle"));
  assert(!screen(frame).includes("History ·"));
  const header = screen(frame)
    .split("\n")
    .find((line) => line.trim().startsWith("/btw "));
  assert(header !== undefined, "Saved answers use the same command/question heading without a timestamp.");
  equal(host.requests.length, 0);
});

test("a new question after browsing does not send saved questions or answers to the model", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.text("new side answer")]);
  await using host = loaded.host;
  await loaded.main.send("main task");
  await loaded.history.save({ ...record, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:ask");
  await waitFor(() => screen(frame).includes("earlier answer"));
  frame.paste("an independent new question");
  frame.key("enter");
  await waitFor(() => screen(frame).includes("new side answer"));
  const sent = JSON.stringify(host.requests[1]?.messages);
  assert(sent.includes("an independent new question"));
  assert(!sent.includes("earlier question"));
  assert(!sent.includes("earlier answer"));
  equal((await loaded.history.list(loaded.main.id)).entries.length, 2);
  frame.key("esc");
  loaded.tui.commands.run("btw:ask");
  await waitFor(() => screen(frame).includes("new side answer"));
  equal(host.requests.length, 2);
});

test("history deletion requires explicit confirmation and respects the session scope", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  await loaded.history.save({ ...record, sessionId: loaded.main.id });
  await loaded.history.save({ ...record, sessionId: "other-session", question: "other question" });
  loaded.tui.commands.run("btw:history");
  await waitFor(() => screen(frame).includes("earlier question"));
  frame.key("tab");
  frame.key("ctrl+x");
  assert(
    !screen(frame).includes("Type DELETE"),
    "A scope that is still loading must not delete stale entries.",
  );
  await waitFor(() => screen(frame).includes("other question"));
  frame.key("tab");
  await waitFor(() => screen(frame).includes("earlier question"));
  frame.key("ctrl+x");
  assert(screen(frame).includes("Type DELETE"));
  const confirmTitle = frame.frame.cells.find((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .includes("Delete 1 saved"),
  );
  assert(confirmTitle !== undefined);
  equal(confirmTitle.find((cell) => cell.text === "D")?.style.bg, undefined);
  const confirmInput = frame.frame.cells.find((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .includes("Type DELETE"),
  );
  assert(confirmInput !== undefined);
  equal(confirmInput.find((cell) => cell.text === "T")?.style.bg, undefined);
  frame.key("enter");
  equal((await loaded.history.list()).entries.length, 2);
  frame.key("esc");
  frame.key("ctrl+d");
  frame.paste("DELETE");
  frame.key("enter");
  await waitFor(() => screen(frame).includes("No saved answers"));
  equal(
    (await loaded.history.list()).entries.map((item) => item.question),
    ["other question"],
  );
  frame.key("tab");
  await waitFor(() => screen(frame).includes("other question"));
  frame.key("ctrl+x");
  frame.paste("DELETE");
  frame.key("enter");
  await waitFor(() => screen(frame).includes("No saved answers"));
  equal((await loaded.history.list()).entries, []);
  equal(host.requests.length, 0);
});

test("a narrow confirmation rejects lowercase input and Ctrl+C returns to history", async () => {
  using frame = createFrame({ width: 32, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  await loaded.history.save({ ...record, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:history");
  await waitFor(() => screen(frame).includes("earlier question"));

  frame.key("ctrl+d");
  frame.paste("delete");
  frame.key("enter");
  assert(screen(frame).includes("Delete 1 saved"));
  equal((await loaded.history.list()).entries.length, 1);

  frame.key("ctrl+c");
  assert(!screen(frame).includes("Type DELETE"));
  assert(screen(frame).includes("btw history"));
});

test("storage failure preserves the answer and reports that it was not saved", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.text("do not lose this answer")]);
  await using host = loaded.host;
  await loaded.main.send("main task");
  await mkdir(`${loaded.dataDir}/history`);
  await writeTextFile(`history/${loaded.main.id}`, "not a directory", { baseDir: loaded.dataDir });
  loaded.tui.commands.run("btw:ask");
  frame.draw();
  frame.paste("side question");
  frame.key("enter");
  await waitFor(() => screen(frame).includes("do not lose this answer"));
  await waitFor(() => host.notices.some((notice) => notice.message.includes("was not saved")));
  frame.key("ctrl+y");
  equal(frame.copies, ["do not lose this answer"]);
});

test("flat presentation preserves Markdown highlights and copying the original answer", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  loaded.tui.styles.set("markdown.strong", { bold: true });
  loaded.tui.styles.set("markdown.code", { fg: "warn" });
  const answer = "Use **bold** and `inline`.";
  await loaded.history.save({ ...record, answer, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:ask");
  await waitFor(() => screen(frame).includes("Use bold and inline."));
  const row = frame.frame.cells.find((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .includes("Use bold and inline."),
  );
  assert(row !== undefined);
  const text = row.map((cell) => cell.text).join("");
  equal(row[text.indexOf("bold")]?.style.bold, true);
  equal(row[text.indexOf("inline")]?.style.fg, "#e3b341");
  equal(row[text.indexOf("inline")]?.style.bg, undefined);
  frame.key("ctrl+y");
  equal(frame.copies, [answer]);
  equal(host.requests.length, 0);
});

test("long multiline questions wrap without losing text or replacing the answer", async () => {
  using frame = createFrame({ width: 32, height: 30 });
  const loaded = await setup(frame);
  await using host = loaded.host;
  const question = "first line with enough words to wrap across the narrow terminal\nlast line 界";
  const answer = "An independent answer.";
  await loaded.history.save({ ...record, question, answer, sessionId: loaded.main.id });
  loaded.tui.commands.run("btw:ask");
  await waitFor(() => screen(frame).includes(answer));
  for (const width of [32, 100]) {
    frame.resize({ width, height: 30 });
    const lines = screen(frame).split("\n");
    const start = lines.findIndex((line) => line.includes("/btw"));
    const end = lines.findIndex((line, i) => i > start && line.trim() === "");
    assert(start >= 0 && end > start + 1, "The multiline question must remain visible across rows.");
    equal(
      lines.slice(start, end).join(" ").trim().replaceAll(/\s+/g, " "),
      `/btw ${question}`.replaceAll(/\s+/g, " "),
    );
    assert(lines.some((line) => line.includes(answer)));
    const continuation = frame.frame.cells[start + 1];
    assert(continuation !== undefined);
    equal(continuation.find((cell) => cell.text.trim() !== "")?.style.dim, true);
  }
  frame.key("ctrl+y");
  equal(frame.copies, [answer]);
  equal(host.requests.length, 0);
});

test("an arriving answer preserves output focus and the next independent draft", async () => {
  using frame = createFrame({ width: 100, height: 30 });
  const loaded = await setup(frame, [reply.text("main answer"), reply.text("the new side answer")]);
  await using host = loaded.host;
  await loaded.main.send("main task");

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

  await waitFor(() => screen(frame).includes("the new side answer"));
  equal(loaded.tui.focused, output, "Request completion must not steal focus back from the answer.");
  equal(editor.state.text, "the next independent draft");

  frame.key("ctrl+y");
  equal(frame.copies, ["the new side answer"]);
  frame.key("tab");
  equal(loaded.tui.focused, editor);
  equal(editor.state.text, "the next independent draft");
  equal(host.requests.length, 2);
});
