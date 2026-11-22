import { mkdir, writeTextFile } from "yuke:fs";
import { assert, assertEquals, type FrameTest, reply } from "yuke:test";
import { History } from "../src/history.ts";
import { scenario, waitForScreen } from "./support.ts";

const record = {
  model: { provider: "provider", model: "model" },
  question: "earlier question",
  answer: "earlier answer",
};

/** Type the slash command of the history browser in the composer of the chat. */
function openHistory(frame: FrameTest): void {
  frame.paste("/btw:history");
  frame.key("enter");
}

/** The cells of the first row of the frame that holds `text`. */
function cellsOf(frame: FrameTest, text: string) {
  const row = frame.rows().findIndex((line) => line.includes(text));
  const cells = frame.frame.cells[row];
  assert(cells !== undefined, `No row holds ${text}.`);
  return cells;
}

scenario("saved answers reopen and copy without a main round", { width: 60, height: 30 }, async (s) => {
  await new History(s.dataDir).save({ ...record, sessionId: s.session.id });
  s.frame.key("ctrl+k b");
  await waitForScreen(s.frame, "earlier answer");
  assert(s.frame.rows().some((line) => line.trim() === "/btw earlier question"));

  s.frame.key("ctrl+y");
  assertEquals(s.frame.copies, ["earlier answer"]);
  s.frame.key("esc");
  s.frame.key("ctrl+k b");
  await waitForScreen(s.frame, "earlier answer");
  assertEquals(s.host.requests.length, 0);
  assertEquals(s.session.transcript.entries.length, 0);
});

scenario(
  "a tool-call response copies the same displayed answer before and after reopening history",
  { width: 100, height: 30, replies: [reply.text("main answer"), reply.toolCalls([{ name: "mark", args: {} }])] },
  async (s) => {
    await s.session.sendMessage("main task");
    s.frame.key("ctrl+k b");
    s.frame.paste("side question");
    s.frame.key("enter");
    const notice = "[Response ended: toolCalls. No tool was executed.]";
    await waitForScreen(s.frame, notice);

    const expected = `The model returned no text. No tool was executed.\n\n${notice}`;
    const saved = (await new History(s.dataDir).list(s.session.id)).entries[0];
    assertEquals(saved?.answer, expected);
    s.frame.key("ctrl+y");
    assertEquals(s.frame.copies, [expected]);

    s.frame.key("esc");
    openHistory(s.frame);
    await waitForScreen(s.frame, "side question");
    s.frame.key("enter");
    await waitForScreen(s.frame, notice);
    s.frame.key("ctrl+y");
    assertEquals(s.frame.copies, [expected, expected]);
    assertEquals(s.host.requests.length, 2);
  },
);

scenario(
  "history search finds answer text across sessions without a model call",
  { width: 100, height: 30 },
  async (s) => {
    const history = new History(s.dataDir);
    await history.save({ ...record, sessionId: s.session.id });
    await history.save({
      ...record,
      question: "different question",
      answer: "searchable answer needle",
      sessionId: "other-session",
    });
    openHistory(s.frame);
    await waitForScreen(s.frame, "earlier question");
    const shown = s.frame.rows().join("\n");
    assert(shown.includes("this session"), shown);
    assert(!shown.includes("different question"), shown);
    assert(
      cellsOf(s.frame, "earlier question").find((cell) => cell.text === "e")?.style.bg !== undefined,
      "The selection shows.",
    );

    s.frame.key("tab");
    await waitForScreen(s.frame, "different question");
    s.frame.paste("needle");
    assert(!s.frame.rows().join("\n").includes("earlier question"));
    s.frame.key("enter");
    await waitForScreen(s.frame, "searchable answer needle");
    assert(s.frame.rows().some((line) => line.trim() === "/btw different question"));
    assertEquals(s.host.requests.length, 0);
  },
);

scenario(
  "a new question after browsing does not send saved questions or answers to the model",
  { width: 100, height: 30, replies: [reply.text("main answer"), reply.text("new side answer")] },
  async (s) => {
    await s.session.sendMessage("main task");
    const history = new History(s.dataDir);
    await history.save({ ...record, sessionId: s.session.id });
    s.frame.key("ctrl+k b");
    await waitForScreen(s.frame, "earlier answer");
    s.frame.paste("an independent new question");
    s.frame.key("enter");
    await waitForScreen(s.frame, "new side answer");
    const sent = JSON.stringify(s.host.requests[1]?.messages);
    assert(sent.includes("an independent new question"));
    assert(!sent.includes("earlier question"));
    assert(!sent.includes("earlier answer"));
    assertEquals((await history.list(s.session.id)).entries.length, 2);

    s.frame.key("esc");
    s.frame.key("ctrl+k b");
    await waitForScreen(s.frame, "new side answer");
  },
);

scenario(
  "history deletion needs the typed word and respects the session scope",
  { width: 100, height: 30 },
  async (s) => {
    const history = new History(s.dataDir);
    await history.save({ ...record, sessionId: s.session.id });
    await history.save({ ...record, sessionId: "other-session", question: "other question" });
    openHistory(s.frame);
    await waitForScreen(s.frame, "earlier question");
    s.frame.key("tab");
    s.frame.key("ctrl+x");
    assert(
      !s.frame.rows().join("\n").includes("Type DELETE"),
      "A scope that still loads does not delete stale entries.",
    );
    await waitForScreen(s.frame, "other question");
    s.frame.key("tab");
    await waitForScreen(s.frame, "earlier question");
    s.frame.key("ctrl+x");
    const confirm = s.frame.rows().join("\n");
    assert(confirm.includes("Delete 1 saved") && confirm.includes("Type DELETE"), confirm);

    s.frame.key("enter");
    assertEquals((await history.list()).entries.length, 2, "Enter without the word deletes nothing.");
    s.frame.key("esc");
    s.frame.key("ctrl+d");
    s.frame.paste("DELETE");
    s.frame.key("enter");
    await waitForScreen(s.frame, "No saved answers");
    assertEquals(
      (await history.list()).entries.map((item) => item.question),
      ["other question"],
    );

    s.frame.key("tab");
    await waitForScreen(s.frame, "other question");
    s.frame.key("ctrl+x");
    s.frame.paste("DELETE");
    s.frame.key("enter");
    await waitForScreen(s.frame, "No saved answers");
    assertEquals((await history.list()).entries, []);
  },
);

scenario(
  "a narrow confirmation rejects lowercase input and Esc returns to history",
  { width: 32, height: 30 },
  async (s) => {
    const history = new History(s.dataDir);
    await history.save({ ...record, sessionId: s.session.id });
    openHistory(s.frame);
    await waitForScreen(s.frame, "earlier question");

    s.frame.key("ctrl+d");
    s.frame.paste("delete");
    s.frame.key("enter");
    assert(s.frame.rows().join("\n").includes("Delete 1 saved"));
    assertEquals((await history.list()).entries.length, 1);

    s.frame.key("esc");
    const back = s.frame.rows().join("\n");
    assert(!back.includes("Type DELETE"), back);
    assert(back.includes("btw history"), back);
  },
);

scenario(
  "a storage failure keeps the answer and reports that it was not saved",
  { width: 100, height: 30, replies: [reply.text("main answer"), reply.text("do not lose this answer")] },
  async (s) => {
    await s.session.sendMessage("main task");
    await mkdir(`${s.dataDir}/history`);
    await writeTextFile(`history/${s.session.id}`, "not a directory", { folder: s.dataDir });
    s.frame.key("ctrl+k b");
    s.frame.paste("side question");
    s.frame.key("enter");
    await waitForScreen(s.frame, "do not lose this answer");
    assert(s.host.notices.some((notice) => notice.text.includes("was not saved")));
    s.frame.key("ctrl+y");
    assertEquals(s.frame.copies, ["do not lose this answer"]);
  },
);

scenario("an answer renders Markdown and copies its original text", { width: 100, height: 30 }, async (s) => {
  const answer = "Use **bold** and `inline`.";
  await new History(s.dataDir).save({ ...record, answer, sessionId: s.session.id });
  s.frame.key("ctrl+k b");
  await waitForScreen(s.frame, "Use bold and inline.");
  const cells = cellsOf(s.frame, "Use bold and inline.");
  const text = cells.map((cell) => cell.text).join("");
  assertEquals(cells[text.indexOf("bold")]?.style.bold, true);
  assertEquals(cells[text.indexOf("Use")]?.style.bold, undefined);
  assert(
    JSON.stringify(cells[text.indexOf("inline")]?.style) !== JSON.stringify(cells[text.indexOf("Use")]?.style),
    "Inline code has its own style.",
  );
  s.frame.key("ctrl+y");
  assertEquals(s.frame.copies, [answer]);
});

scenario("a long multiline question wraps without losing text or the answer", { width: 32, height: 30 }, async (s) => {
  const question = "first line with enough words to wrap across the narrow terminal\nlast line 界";
  const answer = "An independent answer.";
  await new History(s.dataDir).save({ ...record, question, answer, sessionId: s.session.id });
  s.frame.key("ctrl+k b");
  await waitForScreen(s.frame, answer);
  for (const width of [32, 100]) {
    s.frame.resize({ width, height: 30 });
    const lines = s.frame.rows();
    const start = lines.findIndex((line) => line.includes("/btw"));
    const end = lines.findIndex((line, index) => index > start && line.trim() === "");
    assert(start >= 0 && end > start + 1, "The question stays visible across rows.");
    assertEquals(
      lines.slice(start, end).join(" ").replaceAll(/\s+/g, " ").trim(),
      `/btw ${question}`.replaceAll(/\s+/g, " "),
    );
    assert(lines.some((line) => line.includes(answer)));
    const continuation = s.frame.frame.cells[start + 1];
    assertEquals(continuation?.find((cell) => cell.text.trim() !== "")?.style.dim, true);
  }
  s.frame.key("ctrl+y");
  assertEquals(s.frame.copies, [answer]);
});
