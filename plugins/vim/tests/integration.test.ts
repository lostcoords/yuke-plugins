import { equal, test } from "yuke:test";
import { strokeOf, TextEditor } from "yuke:tui";
import { composer, harness } from "./support.ts";

test("Enter reaches the host keymap except when a replacement consumes it", () => {
  const fixture = composer("abc");
  using frame = fixture.frame;
  const native = frame.surface("native");
  const sent: string[] = [];
  native.tui.commands.add({
    name: "send",
    run: () => {
      sent.push(fixture.editor.state.text);
    },
  });
  native.tui.keys.add("enter", "send", { in: "composer" });
  frame.key("esc enter");
  equal(sent, ["abc"]);
  frame.key("r enter");
  equal([fixture.editor.state.text, sent], ["\nbc", ["abc"]]);
});

test("logical and display motions reach different rows of a wrapped draft", () => {
  const fixture = composer("abcdefghij\nXYZ", 2);
  using frame = fixture.frame;
  frame.resize({ width: 10, height: 12 });
  frame.key("esc j");
  equal(fixture.editor.caret, 12);
  fixture.editor.caret = 1;
  frame.key("g j");
  equal(fixture.editor.caret, 7);
  equal(frame.frame.cursor, { column: 3, row: 2, shape: "block" });
});

test("ordinary fields retain native text input and do not enter Normal mode", () => {
  const field = new TextEditor({
    role: "field",
    appearance: { cursorShape: "bar" },
    state: { text: "abc", spans: [], selection: { anchor: 3, head: 3 } },
  });
  const fixture = harness([field]);
  using frame = fixture.frame;
  frame.key("esc b");
  equal([field.state.text, field.caret], ["abcb", 4]);
  equal(frame.frame.cursor, { column: 6, row: 1, shape: "bar" });
});

test("the mode status follows the focused composer and disappears on unload", () => {
  const fixture = composer("abc");
  using frame = fixture.frame;
  const observer = frame.surface("observer");
  const modes = () =>
    observer.tui.status
      .list()
      .filter((entry) => entry.id === "vim:mode")
      .map((entry) => entry.text);
  equal(modes(), ["INSERT"]);
  frame.key("esc");
  equal(modes(), ["NORMAL"]);
  frame.key("v");
  equal(modes(), ["VISUAL"]);
  fixture.surface.close();
  equal(modes(), []);
  frame.key("X");
  equal(fixture.editor.state.text, "Xabc");
});

test("a native control shortcut can reset the draft without leaving Vim history behind", () => {
  const fixture = composer("one two");
  using frame = fixture.frame;
  const native = frame.surface("native");
  native.tui.commands.add({
    name: "clear",
    run: () => fixture.editor.reset({ text: "", spans: [], selection: { anchor: 0, head: 0 } }),
  });
  native.tui.keys.add("ctrl+c", "clear");
  frame.key("esc d w ctrl+c u");
  equal([fixture.editor.state.text, fixture.editor.caret], ["", 0]);
  frame.key("i X esc u");
  equal([fixture.editor.state.text, fixture.editor.caret], ["", 0]);
});

test("an excessive count cancels its operator and the next motion does not delete text", () => {
  const fixture = composer("one two three");
  using frame = fixture.frame;
  frame.key("esc d 9 9 9 9 9 w");
  equal([fixture.editor.state.text, fixture.editor.caret], ["one two three", 4]);
});

test("native key sequences survive caret changes in Insert and Normal modes", () => {
  for (const mode of ["", "esc"]) {
    const fixture = composer("abc");
    using frame = fixture.frame;
    const native = frame.surface("native");
    native.tui.commands.add({
      name: "replace",
      run: () => fixture.editor.reset({ text: "host", spans: [], selection: { anchor: 0, head: 0 } }),
    });
    native.tui.keys.add("ctrl+k m", "replace", { in: "composer" });
    frame.key(`${mode} ctrl+k`);
    fixture.editor.caret = 1;
    frame.key("m");
    equal([fixture.editor.state.text, fixture.editor.caret], ["host", 0]);
  }
});

test("an unmatched native sequence continues as a Vim key in Normal mode", () => {
  const fixture = composer("abc");
  using frame = fixture.frame;
  const native = frame.surface("native");
  native.tui.commands.add({ name: "unused", run() {} });
  native.tui.keys.add("ctrl+k m", "unused", { in: "composer" });
  frame.key("esc ctrl+k x");
  equal([fixture.editor.state.text, fixture.editor.caret], ["bc", 0]);
  frame.key("u");
  equal(fixture.editor.state.text, "abc");
});

test("Escape cancels a native sequence and enters Normal mode", () => {
  const fixture = composer("abc");
  using frame = fixture.frame;
  const native = frame.surface("native");
  native.tui.commands.add({ name: "unused", run() {} });
  native.tui.keys.add("ctrl+k m", "unused", { in: "composer" });
  frame.key("ctrl+k esc x");
  equal([fixture.editor.state.text, fixture.editor.caret], ["bc", 0]);
});

function observeNextHandler(fixture: ReturnType<typeof composer>) {
  const keys: string[] = [];
  fixture.editor.extend(fixture.surface.signal).addKeyHandler((event) => {
    keys.push(strokeOf(event));
    return true;
  });
  const mode = () => fixture.surface.tui.status.list().find((item) => item.id === "vim:mode")?.text;
  return { keys, mode };
}

test("Normal Down reaches the next handler on the last row without changing the caret or mode", () => {
  const fixture = composer("one\ntwo");
  using frame = fixture.frame;
  const next = observeNextHandler(fixture);
  frame.key("esc");
  fixture.editor.caret = 5;
  frame.key("down");
  equal([next.keys, fixture.editor.state.text, fixture.editor.caret, next.mode()], [["down"], "one\ntwo", 5, "NORMAL"]);
  frame.key("x");
  equal(fixture.editor.state.text, "one\nto");
});

test("Normal Down moves the caret before the last row", () => {
  const fixture = composer("one\ntwo\nsix");
  using frame = fixture.frame;
  const next = observeNextHandler(fixture);
  frame.key("esc");
  fixture.editor.caret = 1;
  frame.key("down");
  equal([next.keys, fixture.editor.caret, next.mode()], [[], 5, "NORMAL"]);
  frame.key("down down");
  equal([next.keys, fixture.editor.caret, next.mode()], [["down"], 9, "NORMAL"]);
});

test("Normal Down reaches the next handler only on the final display row of a wrapped line", () => {
  const fixture = composer("abcdefghij");
  using frame = fixture.frame;
  const next = observeNextHandler(fixture);
  frame.resize({ width: 10, height: 12 });
  frame.key("esc");
  fixture.editor.caret = 1;
  frame.key("down");
  equal(next.keys, []);
  fixture.editor.caret = 7;
  frame.key("down");
  equal([next.keys, fixture.editor.caret, next.mode()], [["down"], 7, "NORMAL"]);
});

test("j remains a Vim motion on the last row", () => {
  const fixture = composer("one\ntwo");
  using frame = fixture.frame;
  const next = observeNextHandler(fixture);
  frame.key("esc");
  fixture.editor.caret = 5;
  frame.key("j");
  equal([next.keys, fixture.editor.caret, next.mode()], [[], 5, "NORMAL"]);
  frame.key("down");
  equal(next.keys, ["down"]);
});

test("counted Down remains a Vim motion on the last row and consumes its count", () => {
  const fixture = composer("one\ntwo");
  using frame = fixture.frame;
  const next = observeNextHandler(fixture);
  frame.key("esc");
  fixture.editor.caret = 5;
  frame.key("down 2 down");
  equal([next.keys, fixture.editor.caret, next.mode()], [["down"], 5, "NORMAL"]);
  frame.key("x");
  equal(fixture.editor.state.text, "one\nto");
});

test("operator Down remains a Vim command on the last row", () => {
  for (const command of ["d", "2 d"]) {
    const fixture = composer("one\ntwo");
    using frame = fixture.frame;
    const next = observeNextHandler(fixture);
    frame.key("esc");
    fixture.editor.caret = 5;
    frame.key(`down ${command} down`);
    equal([next.keys, fixture.editor.state.text, fixture.editor.caret, next.mode()], [["down"], "one", 0, "NORMAL"]);
    frame.key("u down");
    equal([next.keys, fixture.editor.state.text, next.mode()], [["down", "down"], "one\ntwo", "NORMAL"]);
  }
});

test("Visual mode keeps Down on the last row", () => {
  const fixture = composer("one\ntwo");
  using frame = fixture.frame;
  const next = observeNextHandler(fixture);
  frame.key("esc");
  fixture.editor.caret = 5;
  frame.key("v down");
  equal([next.keys, fixture.editor.caret, next.mode()], [[], 5, "VISUAL"]);
  frame.key("esc down");
  equal([next.keys, next.mode()], [["down"], "NORMAL"]);
});

test("Normal Down leaves a pending replacement intact when it reaches the next handler", () => {
  const fixture = composer("one\ntwo");
  using frame = fixture.frame;
  const next = observeNextHandler(fixture);
  frame.key("esc");
  fixture.editor.caret = 5;
  frame.key("r down");
  equal([next.keys, fixture.editor.caret, next.mode()], [["down"], 5, "NORMAL"]);
  frame.key("Z");
  equal([fixture.editor.state.text, next.mode()], ["one\ntZo", "NORMAL"]);
});
