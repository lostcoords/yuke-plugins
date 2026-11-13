import { assertEquals, test } from "yuke:test";
import { TextEditor } from "yuke:tui";
import { composer, harness } from "./support.ts";

const cases: readonly [string, string, number, string, string, number][] = [
  ["word start", "alpha beta", 0, "w", "alpha beta", 6],
  ["word end", "alpha beta", 0, "e", "alpha beta", 4],
  ["previous word", "alpha beta", 6, "b", "alpha beta", 0],
  ["punctuation is a word", "foo!!!bar baz", 0, "w", "foo!!!bar baz", 3],
  ["WORD crosses punctuation", "foo!!!bar baz", 0, "W", "foo!!!bar baz", 10],
  ["counted word motion", "one two three four", 0, "2 w", "one two three four", 8],
  ["preferred column survives a short line", "abcdef\nx\nabcdef", 4, "j j", "abcdef\nx\nabcdef", 13],
  ["first nonblank", "  alpha beta", 8, "^", "  alpha beta", 2],
  ["last character", "alpha beta", 0, "$", "alpha beta", 9],
  ["counted line address", "  a\n  b\nc", 0, "2 G", "  a\n  b\nc", 6],
  ["find and repeat", "a,b,c,d", 0, "f , ;", "a,b,c,d", 3],
  ["till excludes its target", "foo(bar)baz", 4, "d t )", "foo()baz", 4],
  ["matching nested bracket", "a(b[c]d)e", 1, "%", "a(b[c]d)e", 7],
  ["delete word includes its following space", "alpha beta", 0, "d w", "beta", 0],
  ["delete to word end", "alpha beta", 0, "d e", " beta", 0],
  ["operator and motion counts multiply", "one two three four five", 0, "2 d 2 w", "five", 0],
  ["doubled line operator counts multiply", "a\nb\nc\nd\ne", 0, "2 d 2 d", "e", 0],
  ["change word leaves its separator", "alpha beta", 0, "c w X esc", "X beta", 0],
  ["delete inner punctuation", "foo!!!bar", 4, "d i w", "foobar", 3],
  ["delete inner whitespace", "foo   bar", 4, "d i w", "foobar", 3],
  ["delete around word", "foo bar", 4, "d a w", "foo", 2],
  ["change inner quotes", 'say "hello" now', 6, 'c i " n e w esc', 'say "new" now', 7],
  ["delete around quotes", "say 'hello' now", 6, "d a '", "say now", 4],
  ["counted nested object", "f(one (two) three)", 8, "d 2 i (", "f()", 2],
  ["absent text object cancels its operator", "plain text", 0, 'd i " x', "lain text", 0],
  ["insert before", "abc", 1, "i X Y esc", "aXYbc", 2],
  ["append after", "abc", 1, "a X Y esc", "abXYc", 3],
  ["insert at first nonblank", "  abc", 4, "I X esc", "  Xabc", 2],
  ["append at line end", "abc\ndef", 0, "A X esc", "abcX\ndef", 3],
  ["open below", "abc", 0, "o X esc", "abc\nX", 4],
  ["open above", "abc", 0, "O X esc", "X\nabc", 0],
  ["counted insert", "abc", 0, "3 i X esc", "XXXabc", 2],
  ["character replacement counts graphemes", "ab 👩‍💻🇯🇵", 3, "2 r X", "ab XX", 4],
  ["replacement count stops at the line boundary", "abc", 1, "3 r X", "abc", 1],
  ["join trims indentation", "one\n  two\nthree", 0, "J", "one two\nthree", 3],
  ["uppercase inner word", "AbC dEf", 0, "g U i w", "ABC dEf", 0],
  ["indent a line", "one\ntwo", 0, "> >", "  one\ntwo", 2],
  ["dot repeats an operator", "one two three four", 0, "d w .", "three four", 0],
  ["undo and redo preserve dot", "one two three four", 0, "d w u ctrl+r .", "three four", 0],
];

for (const [behavior, text, caret, keys, expectedText, expectedCaret] of cases) {
  test(`normal mode: ${behavior}`, () => {
    const fixture = composer(text);
    using frame = fixture.frame;
    frame.key("esc");
    fixture.editor.caret = caret;
    frame.key(keys);
    assertEquals([fixture.editor.state.text, fixture.editor.caret], [expectedText, expectedCaret]);
    assertEquals(fixture.editor.selection, { anchor: expectedCaret, head: expectedCaret });
  });
}

test("the editor starts in insert mode and Escape changes the visible cursor before any motion", () => {
  const fixture = composer();
  using frame = fixture.frame;
  frame.key("a b c");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["abc", 3]);
  assertEquals(frame.frame.cursor, { column: 5, row: 1, shape: "bar" });
  frame.key("esc");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["abc", 2]);
  assertEquals(frame.frame.cursor, { column: 4, row: 1, shape: "block" });
  frame.key("b i X");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["Xabc", 1]);
  assertEquals(frame.frame.cursor, { column: 3, row: 1, shape: "bar" });
});

test("visual selection includes whole graphemes and yanks only that selection", () => {
  const fixture = composer("a👩‍💻e\u0301b");
  using frame = fixture.frame;
  frame.key("esc l v l");
  assertEquals(fixture.editor.state.text, "a👩‍💻e\u0301b");
  assertEquals(fixture.editor.caret, 6);
  assertEquals(frame.frame.cursor, { column: 5, row: 1, shape: "block" });
  assertEquals(
    frame.frame.cells[1]?.slice(3, 6).map((cell) => cell.style.reverse),
    [true, true, true],
  );
  frame.key("y");
  assertEquals(frame.copies, ["👩‍💻e\u0301"]);
  assertEquals([fixture.editor.caret, fixture.editor.selection], [1, { anchor: 1, head: 1 }]);
  frame.key("$ p");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["a👩‍💻e\u0301b👩‍💻e\u0301", 14]);
});

test("deletion and put preserve whole Unicode clusters and combining characters", () => {
  const fixture = composer("a👩‍💻e\u0301");
  using frame = fixture.frame;
  frame.key("esc l x");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["ae\u0301", 1]);
  frame.key("P");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["a👩‍💻e\u0301", 1]);
  frame.key("l x u");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["a👩‍💻e\u0301", 6]);
  assertEquals(frame.copies, []);
});

test("deletion snaps the caret when regional indicators join into one cluster", () => {
  const fixture = composer("🇯x🇵");
  using frame = fixture.frame;
  frame.key("esc l x");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["🇯🇵", 0]);
  assertEquals(frame.frame.cursor, { column: 2, row: 1, shape: "block" });
});

test("CRLF append stays before the line end and line deletion removes both end units", () => {
  const fixture = composer("first\r\nsecond");
  using frame = fixture.frame;
  frame.key("esc A X esc");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["firstX\r\nsecond", 5]);
  frame.key("d d");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["second", 0]);
  frame.key("P");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["firstX\nsecond", 0]);
});

test("linewise delete and put handle the final line without adding an empty line", () => {
  const fixture = composer("a\nb\nc");
  using frame = fixture.frame;
  frame.key("esc G d d");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["a\nb", 2]);
  frame.key("p");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["a\nb\nc", 4]);
  frame.key("d d P");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["a\nc\nb", 2]);
});

test("linewise yanks copy line text while puts and deletes keep the clipboard unchanged", () => {
  const fixture = composer("first\nsecond");
  using frame = fixture.frame;
  frame.key("esc y y");
  assertEquals(frame.copies, ["first"]);
  frame.key("p");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["first\nfirst\nsecond", 6]);
  frame.key("d d");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["first\nsecond", 6]);
  assertEquals(frame.copies, ["first"]);
});

test("named register append and the black hole keep independent register contents", () => {
  const fixture = composer("red blue");
  using frame = fixture.frame;
  frame.key('esc " a y i w w " A y i w');
  assertEquals(frame.copies, ["red", "blue"]);
  frame.key('" _ y i w');
  assertEquals(frame.copies, ["red", "blue"]);
  frame.key('0 " a P');
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["redbluered blue", 6]);
  assertEquals(frame.copies, ["red", "blue"]);
});

test("composers share registers but keep their modes and undo histories separate", () => {
  const first = new TextEditor({
    role: "composer",
    state: { text: "red blue", selection: { anchor: 0, head: 0 }, spans: [] },
  });
  const second = new TextEditor({
    role: "composer",
    state: { text: "Y", selection: { anchor: 0, head: 0 }, spans: [] },
  });
  const fixture = harness([first, second]);
  using frame = fixture.frame;
  frame.key("esc y i w");
  assertEquals(frame.copies, ["red"]);
  assertEquals(fixture.surface.tui.focus(second), true);
  frame.key("X esc p");
  assertEquals([second.state.text, second.caret], ["XredY", 3]);
  frame.key("u");
  assertEquals([second.state.text, second.caret], ["XY", 0]);
  assertEquals(fixture.surface.tui.focus(first), true);
  frame.key("w");
  assertEquals([first.state.text, first.caret], ["red blue", 4]);
  frame.key("p");
  assertEquals(first.state.text, "red bredlue");
  assertEquals(second.state.text, "XY");
});

test("insert typing, paste, and Ctrl+W form an undo group that redo restores", () => {
  const fixture = composer("hola\r\nchao", 10);
  using frame = fixture.frame;
  frame.key("ctrl+w");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["hola\r\n", 6]);
  frame.paste("new");
  frame.key("! esc");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["hola\r\nnew!", 9]);
  frame.key("u");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["hola\r\nchao", 9]);
  frame.key("ctrl+r");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["hola\r\nnew!", 9]);
});

test("undo and redo restore image and paste spans with their metadata", () => {
  const fixture = composer("a\uFFFCbcdefz", 0, [
    {
      from: 1,
      to: 2,
      kind: "image",
      label: "[image 1]",
      media: { blob: { digest: "abc", len: 3 }, mimeType: "image/png" },
    },
    { from: 2, to: 7, kind: "paste", label: "[5 chars]" },
  ]);
  using frame = fixture.frame;
  frame.key("esc l 2 x");
  assertEquals(fixture.editor.state, { text: "az", selection: { anchor: 1, head: 1 }, spans: [] });
  frame.key("u");
  assertEquals(fixture.editor.state, {
    text: "a\uFFFCbcdefz",
    selection: { anchor: 1, head: 1 },
    spans: [
      {
        from: 1,
        to: 2,
        kind: "image",
        label: "[image 1]",
        media: { blob: { digest: "abc", len: 3 }, mimeType: "image/png" },
      },
      { from: 2, to: 7, kind: "paste", label: "[5 chars]" },
    ],
  });
  frame.key("ctrl+r");
  assertEquals(fixture.editor.state, { text: "az", selection: { anchor: 1, head: 1 }, spans: [] });
});

test("reset clears old undo and redo histories without preventing new edits", () => {
  const fixture = composer("old draft");
  using frame = fixture.frame;
  frame.key("esc d w u");
  assertEquals(fixture.editor.state.text, "old draft");
  fixture.editor.reset({ text: "new draft", selection: { anchor: 0, head: 0 }, spans: [] });
  frame.key("u ctrl+r");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["new draft", 0]);
  frame.key("x");
  assertEquals(fixture.editor.state.text, "ew draft");
  frame.key("u");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["new draft", 0]);
});

test("Escape takes ownership before the interrupt keymap and unload restores native keys", () => {
  const fixture = composer("abc", 3);
  using frame = fixture.frame;
  const native = frame.surface("native");
  const actions: string[] = [];
  native.tui.commands.add({
    name: "interrupt",
    run: () => {
      actions.push("interrupt");
    },
  });
  native.tui.keys.add("esc", "native:interrupt");
  frame.key("esc b");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["abc", 0]);
  assertEquals(actions, []);
  fixture.surface.close();
  frame.key("esc X left");
  assertEquals(actions, ["interrupt"]);
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["Xabc", 0]);
  assertEquals(frame.frame.cursor, { column: 2, row: 1, shape: "bar" });
});

test("Enter submits normally but completes a pending replacement without submitting", () => {
  const fixture = composer("abc", 3);
  using frame = fixture.frame;
  frame.key("enter");
  assertEquals(fixture.submitted, [{ text: "abc", selection: { anchor: 3, head: 3 }, spans: [] }]);
  frame.key("esc enter");
  assertEquals(fixture.submitted, [
    { text: "abc", selection: { anchor: 3, head: 3 }, spans: [] },
    { text: "abc", selection: { anchor: 2, head: 2 }, spans: [] },
  ]);
  frame.key("0 r enter");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["\nbc", 1]);
  assertEquals(fixture.submitted.length, 2);
  frame.key("enter");
  assertEquals(fixture.submitted[2], { text: "\nbc", selection: { anchor: 1, head: 1 }, spans: [] });
});

test("slash inserts the command prefix without discarding the draft", () => {
  const fixture = composer("keep this draft", 5);
  using frame = fixture.frame;
  frame.key("esc /");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["keep/ this draft", 5]);
  assertEquals(frame.frame.cursor, { column: 7, row: 1, shape: "bar" });
  frame.key("X");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["keep/X this draft", 6]);
});

test("resize reflows a normal caret without changing the draft or logical motion", () => {
  const fixture = composer("abcdefghij klmnop");
  using frame = fixture.frame;
  frame.key("esc w");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["abcdefghij klmnop", 11]);
  frame.resize({ width: 14, height: 12 });
  assertEquals(frame.frame.cursor, { column: 2, row: 2, shape: "block" });
  frame.key("b");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["abcdefghij klmnop", 0]);
  assertEquals(frame.frame.cursor, { column: 2, row: 1, shape: "block" });
});

test("undo restores image metadata when text and span ranges stay equal", () => {
  const fixture = composer("\uFFFC", 0, [
    {
      from: 0,
      to: 1,
      kind: "image",
      label: "[image]",
      media: { blob: { digest: "first", len: 3 }, mimeType: "image/png" },
    },
  ]);
  using frame = fixture.frame;
  fixture.editor.replace(0, 1, "\uFFFC", [
    {
      from: 0,
      to: 1,
      kind: "image",
      label: "[image]",
      media: { blob: { digest: "second", len: 4 }, mimeType: "image/jpeg", filename: "second.jpg" },
    },
  ]);
  frame.key("esc u");
  assertEquals(fixture.editor.state.spans, [
    {
      from: 0,
      to: 1,
      kind: "image",
      label: "[image]",
      media: { blob: { digest: "first", len: 3 }, mimeType: "image/png" },
    },
  ]);
  frame.key("ctrl+r");
  assertEquals(fixture.editor.state.spans, [
    {
      from: 0,
      to: 1,
      kind: "image",
      label: "[image]",
      media: { blob: { digest: "second", len: 4 }, mimeType: "image/jpeg", filename: "second.jpg" },
    },
  ]);
});

test("the previous Visual area follows inserted lines but keeps same-line columns", () => {
  const fixture = composer("top\nabcd");
  using frame = fixture.frame;
  frame.key("esc j l v l esc g g O X esc g v y");
  assertEquals([fixture.editor.state.text, frame.copies], ["X\ntop\nabcd", ["bc"]]);
  frame.key("u g v y");
  assertEquals([fixture.editor.state.text, frame.copies], ["top\nabcd", ["bc", "bc"]]);
  frame.key("ctrl+r g v y");
  assertEquals([fixture.editor.state.text, frame.copies], ["X\ntop\nabcd", ["bc", "bc", "bc"]]);
  const sameLine = composer("abcd");
  using sameFrame = sameLine.frame;
  sameFrame.key("esc l v l esc 0 i X esc g v y");
  assertEquals([sameLine.editor.state.text, sameFrame.copies], ["Xabcd", ["ab"]]);
});

for (const key of [
  "ctrl+w",
  "ctrl+u",
  "ctrl+k",
  "ctrl+h",
  "alt+d",
  "alt+backspace",
  "ctrl+backspace",
  "super+backspace",
  "ctrl+delete",
  "alt+delete",
  "shift+enter",
  "alt+enter",
  "ctrl+j",
]) {
  for (const mode of ["", "v"]) {
    test(`${mode ? "visual" : "normal"} mode: native editing key ${key} leaves the draft unchanged`, () => {
      const fixture = composer("abc def");
      using frame = fixture.frame;
      frame.key("esc");
      fixture.editor.caret = 4;
      if (mode) frame.key(mode);
      frame.key(key);
      assertEquals([fixture.editor.state.text, fixture.submitted.length], ["abc def", 0]);
    });
  }
}

const deletionKeys: readonly [string, string, number, string, string, number][] = [
  ["backspace moves left", "abc def", 4, "backspace", "abc def", 3],
  ["backspace stops at the line start", "abc\ndef", 4, "backspace", "abc\ndef", 4],
  ["backspace takes a count", "abc def", 5, "3 backspace", "abc def", 2],
  ["d backspace deletes the previous character", "abc def", 4, "d backspace", "abcdef", 3],
  ["delete acts as x", "abc def", 4, "delete", "abc ef", 4],
  ["delete takes a count", "abc def", 4, "2 delete", "abc f", 4],
  ["delete deletes a visual selection", "abc def", 4, "v l delete", "abc f", 4],
  ["delete repeats with dot", "abcdef", 0, "delete .", "cdef", 0],
];

for (const [behavior, text, caret, keys, expectedText, expectedCaret] of deletionKeys) {
  test(`normal mode: ${behavior}`, () => {
    const fixture = composer(text);
    using frame = fixture.frame;
    frame.key("esc");
    fixture.editor.caret = caret;
    frame.key(keys);
    assertEquals([fixture.editor.state.text, fixture.editor.caret], [expectedText, expectedCaret]);
  });
}

test("insert mode keeps native backspace, delete, and word deletion", () => {
  const fixture = composer("abc def", 4);
  using frame = fixture.frame;
  frame.key("backspace delete");
  assertEquals(fixture.editor.state.text, "abcef");
  frame.key("alt+backspace");
  assertEquals(fixture.editor.state.text, "ef");
});
