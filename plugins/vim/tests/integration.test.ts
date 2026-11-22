import { assertEquals, test } from "yuke:test";
import { strokeOf, TextEditor } from "yuke:tui";
import { composer, harness } from "./support.ts";

test("Enter reaches the host keymap except when a replacement consumes it", async () => {
  await using fixture = await composer("abc");
  const frame = fixture.frame;
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
  assertEquals(sent, ["abc"]);
  frame.key("r enter");
  assertEquals([fixture.editor.state.text, sent], ["\nbc", ["abc"]]);
});

test("logical and display motions reach different rows of a wrapped draft", async () => {
  await using fixture = await composer("abcdefghij\nXYZ", 2);
  const frame = fixture.frame;
  frame.resize({ width: 10, height: 12 });
  frame.key("esc j");
  assertEquals(fixture.editor.caret, 12);
  fixture.editor.caret = 1;
  frame.key("g j");
  assertEquals(fixture.editor.caret, 7);
  assertEquals(frame.frame.cursor, { column: 3, row: 2, shape: "block" });
});

test("ordinary fields retain native text input and do not enter Normal mode", async () => {
  const field = new TextEditor({
    role: "field",
    appearance: { cursorShape: "bar" },
    state: { text: "abc", spans: [], selection: { anchor: 3, head: 3 } },
  });
  await using fixture = await harness([field]);
  const frame = fixture.frame;
  frame.key("esc b");
  assertEquals([field.state.text, field.caret], ["abcb", 4]);
  assertEquals(frame.frame.cursor, { column: 6, row: 1, shape: "bar" });
});

test("the mode status follows the focused composer and disappears on unload", async () => {
  await using fixture = await composer("abc");
  const frame = fixture.frame;
  const observer = frame.surface("observer");
  const modes = () =>
    observer.tui.status
      .list()
      .filter((entry) => entry.id === "vim:mode")
      .map((entry) => entry.text);
  assertEquals(modes(), ["INSERT"]);
  frame.key("esc");
  assertEquals(modes(), ["NORMAL"]);
  frame.key("v");
  assertEquals(modes(), ["VISUAL"]);
  await fixture.host.close();
  assertEquals(modes(), []);
  frame.key("X");
  assertEquals(fixture.editor.state.text, "Xabc");
});

test("a native control shortcut can reset the draft without leaving Vim history behind", async () => {
  await using fixture = await composer("one two");
  const frame = fixture.frame;
  const native = frame.surface("native");
  native.tui.commands.add({
    name: "clear",
    run: () => fixture.editor.reset({ text: "", spans: [], selection: { anchor: 0, head: 0 } }),
  });
  native.tui.keys.add("ctrl+c", "clear");
  frame.key("esc d w ctrl+c u");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["", 0]);
  frame.key("i X esc u");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["", 0]);
});

test("an excessive count cancels its operator and the next motion does not delete text", async () => {
  await using fixture = await composer("one two three");
  const frame = fixture.frame;
  frame.key("esc d 9 9 9 9 9 w");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["one two three", 4]);
});

for (const mode of ["", "esc"]) {
  test(`native key sequences survive caret changes in ${mode ? "Normal" : "Insert"} mode`, async () => {
    await using fixture = await composer("abc");
    const frame = fixture.frame;
    const native = frame.surface("native");
    native.tui.commands.add({
      name: "replace",
      run: () => fixture.editor.reset({ text: "host", spans: [], selection: { anchor: 0, head: 0 } }),
    });
    native.tui.keys.add("ctrl+k m", "replace", { in: "composer" });
    frame.key(`${mode} ctrl+k`);
    fixture.editor.caret = 1;
    frame.key("m");
    assertEquals([fixture.editor.state.text, fixture.editor.caret], ["host", 0]);
  });
}

test("an unmatched native sequence continues as a Vim key in Normal mode", async () => {
  await using fixture = await composer("abc");
  const frame = fixture.frame;
  const native = frame.surface("native");
  native.tui.commands.add({ name: "unused", run() {} });
  native.tui.keys.add("ctrl+k m", "unused", { in: "composer" });
  frame.key("esc ctrl+k x");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["bc", 0]);
  frame.key("u");
  assertEquals(fixture.editor.state.text, "abc");
});

test("Escape cancels a native sequence and enters Normal mode", async () => {
  await using fixture = await composer("abc");
  const frame = fixture.frame;
  const native = frame.surface("native");
  native.tui.commands.add({ name: "unused", run() {} });
  native.tui.keys.add("ctrl+k m", "unused", { in: "composer" });
  frame.key("ctrl+k esc x");
  assertEquals([fixture.editor.state.text, fixture.editor.caret], ["bc", 0]);
});

function observeNextHandler(fixture: Awaited<ReturnType<typeof composer>>) {
  const keys: string[] = [];
  fixture.editor.extend(fixture.surface.signal).addKeyHandler((event) => {
    keys.push(strokeOf(event));
    return true;
  });
  const mode = () => fixture.surface.tui.status.list().find((item) => item.id === "vim:mode")?.text;
  return { keys, mode };
}

type DownStep = readonly [keys: string, nextKeys: readonly string[], text: string, caret: number, mode: string];

const downCases: readonly {
  readonly behavior: string;
  readonly text: string;
  readonly caret: number;
  readonly width?: number;
  readonly steps: readonly DownStep[];
}[] = [
  {
    behavior: "Normal Down reaches the next handler on the last row without changing the caret or mode",
    text: "one\ntwo",
    caret: 5,
    steps: [
      ["down", ["down"], "one\ntwo", 5, "NORMAL"],
      ["x", ["down"], "one\nto", 5, "NORMAL"],
    ],
  },
  {
    behavior: "Normal Down moves the caret before the last row",
    text: "one\ntwo\nsix",
    caret: 1,
    steps: [
      ["down", [], "one\ntwo\nsix", 5, "NORMAL"],
      ["down down", ["down"], "one\ntwo\nsix", 9, "NORMAL"],
    ],
  },
  {
    behavior: "Normal Down stays in Vim on a wrapped line before its final display row",
    text: "abcdefghij",
    caret: 1,
    width: 10,
    steps: [["down", [], "abcdefghij", 1, "NORMAL"]],
  },
  {
    behavior: "Normal Down reaches the next handler on the final display row of a wrapped line",
    text: "abcdefghij",
    caret: 7,
    width: 10,
    steps: [["down", ["down"], "abcdefghij", 7, "NORMAL"]],
  },
  {
    behavior: "j remains a Vim motion on the last row",
    text: "one\ntwo",
    caret: 5,
    steps: [
      ["j", [], "one\ntwo", 5, "NORMAL"],
      ["down", ["down"], "one\ntwo", 5, "NORMAL"],
    ],
  },
  {
    behavior: "counted Down remains a Vim motion on the last row and consumes its count",
    text: "one\ntwo",
    caret: 5,
    steps: [
      ["down 2 down", ["down"], "one\ntwo", 5, "NORMAL"],
      ["x", ["down"], "one\nto", 5, "NORMAL"],
    ],
  },
  {
    behavior: "operator Down remains a Vim command on the last row",
    text: "one\ntwo",
    caret: 5,
    steps: [
      ["down d down", ["down"], "one", 0, "NORMAL"],
      ["u down", ["down", "down"], "one\ntwo", 5, "NORMAL"],
    ],
  },
  {
    behavior: "counted operator Down remains a Vim command on the last row",
    text: "one\ntwo",
    caret: 5,
    steps: [
      ["down 2 d down", ["down"], "one", 0, "NORMAL"],
      ["u down", ["down", "down"], "one\ntwo", 5, "NORMAL"],
    ],
  },
  {
    behavior: "Visual mode keeps Down on the last row",
    text: "one\ntwo",
    caret: 5,
    steps: [
      ["v down", [], "one\ntwo", 5, "VISUAL"],
      ["esc down", ["down"], "one\ntwo", 5, "NORMAL"],
    ],
  },
  {
    behavior: "Normal Down leaves a pending replacement intact when it reaches the next handler",
    text: "one\ntwo",
    caret: 5,
    steps: [
      ["r down", ["down"], "one\ntwo", 5, "NORMAL"],
      ["Z", ["down"], "one\ntZo", 5, "NORMAL"],
    ],
  },
];

for (const down of downCases) {
  test(down.behavior, async () => {
    await using fixture = await composer(down.text);
    const frame = fixture.frame;
    const next = observeNextHandler(fixture);
    if (down.width) frame.resize({ width: down.width, height: 12 });
    frame.key("esc");
    fixture.editor.caret = down.caret;
    for (const [keys, nextKeys, text, caret, mode] of down.steps) {
      frame.key(keys);
      assertEquals(
        [next.keys, fixture.editor.state.text, fixture.editor.caret, next.mode()],
        [nextKeys, text, caret, mode],
      );
    }
  });
}
