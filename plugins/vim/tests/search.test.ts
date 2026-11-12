import { assert, equal, test, waitForSettled } from "yuke:test";
import { TextEditor } from "yuke:tui";
import { composer, harness } from "./support.ts";

test("literal search finds the next match and repeat search wraps in both directions", async () => {
  const fixture = composer("one two one");
  using frame = fixture.frame;
  frame.key("esc alt+/");
  assert(fixture.surface.tui.focused instanceof TextEditor);
  equal(fixture.surface.tui.focused.role, "field");
  frame.key("o n e enter");
  // The prompt closes after its answer, and the focus comes back at the next draw.
  await waitForSettled();
  frame.draw();
  equal([fixture.editor.state.text, fixture.editor.caret], ["one two one", 8]);
  equal(fixture.surface.tui.focused, fixture.editor);
  frame.key("n");
  equal(fixture.editor.caret, 0);
  frame.key("N");
  equal(fixture.editor.caret, 8);
});

test("backward search keeps its direction for subsequent repeats", async () => {
  const fixture = composer("one two one");
  using frame = fixture.frame;
  frame.key("esc ? o n e enter");
  // The prompt closes after its answer, and the focus comes back at the next draw.
  await waitForSettled();
  frame.draw();
  equal(fixture.editor.caret, 8);
  frame.key("n");
  equal(fixture.editor.caret, 0);
  frame.key("N");
  equal(fixture.editor.caret, 8);
});

test("an operator can use a literal search as its motion and undo restores the draft", async () => {
  const fixture = composer("one two three");
  using frame = fixture.frame;
  frame.key("esc d alt+/ t h r e e enter");
  // The prompt closes after its answer, and the focus comes back at the next draw.
  await waitForSettled();
  frame.draw();
  equal([fixture.editor.state.text, fixture.editor.caret], ["three", 0]);
  frame.key("u");
  equal([fixture.editor.state.text, fixture.editor.caret], ["one two three", 0]);
});

test("cancel of a search leaves the draft and caret unchanged", () => {
  const fixture = composer("one two one");
  using frame = fixture.frame;
  frame.key("esc w alt+/ o n e esc");
  equal([fixture.editor.state.text, fixture.editor.caret], ["one two one", 4]);
  equal(fixture.surface.tui.focused, fixture.editor);
  frame.key("x");
  equal([fixture.editor.state.text, fixture.editor.caret], ["one wo one", 4]);
});

test("a search answer does not apply to a replacement draft", async () => {
  const fixture = composer("one two one");
  using frame = fixture.frame;
  frame.key("esc alt+/ o n e");
  fixture.editor.reset({ text: "new draft", spans: [], selection: { anchor: 0, head: 0 } });
  frame.key("enter");
  // The prompt closes after its answer, and the focus comes back at the next draw.
  await waitForSettled();
  frame.draw();
  equal([fixture.editor.state.text, fixture.editor.caret], ["new draft", 0]);
  frame.key("x");
  equal(fixture.editor.state.text, "ew draft");
});

test("focus changes cancel a pending operator without changing another composer", () => {
  const first = new TextEditor({
    role: "composer",
    state: { text: "first", spans: [], selection: { anchor: 0, head: 0 } },
  });
  const second = new TextEditor({
    role: "composer",
    state: { text: "second", spans: [], selection: { anchor: 0, head: 0 } },
  });
  const fixture = harness([first, second]);
  using frame = fixture.frame;
  frame.key("esc d");
  fixture.surface.tui.focus(second);
  frame.key("X");
  equal([first.state.text, second.state.text], ["first", "Xsecond"]);
  fixture.surface.tui.focus(first);
  frame.key("w");
  equal([first.state.text, first.caret], ["first", 4]);
});

test("a search dialog closes when its composer leaves the tree", () => {
  const fixture = composer("old draft");
  using frame = fixture.frame;
  frame.key("esc alt+/");
  const replacement = new TextEditor({ role: "field" });
  fixture.surface.tui.wrapRoot(() => replacement);
  frame.draw();
  equal(fixture.surface.tui.focused, replacement);
  frame.key("X");
  equal([replacement.state.text, fixture.editor.state.text], ["X", "old draft"]);
});
