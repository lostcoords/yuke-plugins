import { equal, test } from "yuke:test";
import { composer } from "./support.ts";

test("a composer integration cancels a pending operator and observes mode changes until disposal", () => {
  const fixture = composer("one two");
  using frame = fixture.frame;
  const modes: string[] = [];
  const stop = fixture.vim.onMode((editor, mode) => {
    equal(editor, fixture.editor);
    modes.push(mode);
  });
  fixture.vim.setMode(fixture.editor, "normal");
  frame.key("d");
  equal(fixture.vim.pending(fixture.editor), true);
  fixture.vim.cancel(fixture.editor);
  equal(fixture.vim.pending(fixture.editor), false);
  frame.key("w");
  equal([fixture.editor.state.text, fixture.editor.caret], ["one two", 4]);
  fixture.vim.setMode(fixture.editor, "insert");
  equal(modes, ["normal", "insert"]);
  stop();
  frame.key("esc");
  equal(fixture.vim.mode(fixture.editor), "normal");
  equal(modes, ["normal", "insert"]);
});

test("setting the current mode cancels a pending command and cancel reports a Visual mode exit", () => {
  const fixture = composer("one two");
  using frame = fixture.frame;
  fixture.vim.setMode(fixture.editor, "normal");
  frame.key("d");
  fixture.vim.setMode(fixture.editor, "normal");
  equal(fixture.vim.pending(fixture.editor), false);
  const modes: string[] = [];
  fixture.vim.onMode((_editor, mode) => modes.push(mode));
  frame.key("v l");
  fixture.vim.cancel(fixture.editor);
  equal(fixture.vim.mode(fixture.editor), "normal");
  equal(modes, ["visual", "normal"]);
});
