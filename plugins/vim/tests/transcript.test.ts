import type { PluginContext } from "yuke:plugins";
import { assert, createFrame, assertEquals, test } from "yuke:test";
import { TextEditor, TextView, type View } from "yuke:tui";
import { apply } from "../src/index.ts";

function reader(text = "alpha beta gamma\n你好 hello\nlast line") {
  const group = {};
  const editor = new TextEditor({ role: "composer", group });
  const view = new TextView({
    role: "transcript",
    group,
    document: {
      id: "chat",
      items: [
        {
          id: "a",
          sections: [
            { id: "body", kind: "text", text },
            {
              id: "tool",
              kind: "label",
              text: "read /a/very/long/source/path.txt",
              render: () => [
                { segments: [{ text: "read /a/…", source: { kind: "replacement", from: 0, to: 33 } }], join: "" },
              ],
            },
          ],
        },
      ],
    },
  });
  const visibility = { transcript: true };
  const root: View = {
    initialFocus: editor,
    layout: (size) =>
      visibility.transcript
        ? [
            { view, rect: { column: 0, row: 0, width: size.width, height: size.height - 2 } },
            { view: editor, rect: { column: 0, row: size.height - 2, width: size.width, height: 2 } },
          ]
        : [{ view: editor, rect: { column: 0, row: 0, width: size.width, height: size.height } }],
    draw() {},
  };
  const frame = createFrame({ width: 40, height: 10 }, () => root);
  const surface = frame.surface("vim");
  apply({
    get: (name: string) => {
      assert(name === "tui", `Unexpected service: ${name}`);
      return surface.tui;
    },
    provide() {},
    notify() {},
    signal: surface.signal,
  } as unknown as PluginContext);
  frame.draw();
  frame.key("esc");
  frame.key("tab");
  assert(surface.tui.focused === view);
  return { frame, view, editor, surface, visibility };
}

test("transcript Vim yanks display words and keeps registers available to the composer", () => {
  const { frame, view, editor, surface } = reader();
  using _owned = frame;
  frame.key("g g 0 2 y w");
  assertEquals(frame.copies.at(-1), "alpha beta ");
  assertEquals(view.selection, undefined);
  frame.key("tab");
  assert(surface.tui.focused === editor);
  frame.key("p");
  assertEquals(editor.state.text, "alpha beta ");
});

test("transcript marks keep their source offset after resize and source yanks include an elided title", () => {
  const { frame, view } = reader();
  using _owned = frame;
  frame.key("g g w m a G 0 l l l l l l l");
  // A clipped title stands for its whole source range.
  assertEquals(view.caret?.offset, 0);
  frame.key("g y");
  assertEquals(frame.copies.at(-1), "read /a/very/long/source/path.txt");
  frame.resize({ width: 12, height: 12 });
  frame.key("` a");
  assertEquals(view.caret, { item: "a", section: "body", offset: 6 });
});

test("transcript visual line yanks span Unicode rows and restore the selection", () => {
  const { frame, view } = reader();
  using _owned = frame;
  frame.key("g g j V j y");
  assertEquals(frame.copies.at(-1), "你好 hello\nlast line");
  frame.key("g v");
  assert(view.selection !== undefined);
  frame.key("esc");
  assertEquals(view.selection, undefined);
});

test("whole-word transcript search skips a longer word and repeats in both directions", () => {
  const { frame, view } = reader("alpha alphabet alpha.\nnext alpha");
  using _owned = frame;
  frame.key("g g *");
  assertEquals(view.caret?.offset, 15);
  frame.key("n");
  assertEquals(view.caret?.offset, 27);
  frame.key("N");
  assertEquals(view.caret?.offset, 15);
  frame.key("g g g *");
  assertEquals(view.caret?.offset, 6);
});

test("a transcript search dialog keeps the source cursor while it owns the focus", () => {
  const { frame, view, surface } = reader();
  using _owned = frame;
  frame.key("g g /");
  frame.paste("gamma");
  frame.key("enter");
  assertEquals(view.caret, { item: "a", section: "body", offset: 11 });
  assert(surface.tui.focused === view);
});

test("Tab returns to the same transcript source position after composer editing", () => {
  const { frame, view, editor } = reader();
  using _owned = frame;
  frame.key("g g w tab i");
  frame.paste("draft stays");
  frame.key("esc tab");
  assertEquals(view.caret, { item: "a", section: "body", offset: 6 });
  assertEquals(editor.state.text, "draft stays");
});

test("a native key sequence keeps its continuation while the transcript has focus", () => {
  const { frame, surface } = reader();
  using _owned = frame;
  const native = frame.surface("native");
  let invoked = 0;
  native.tui.commands.add({
    name: "probe",
    run: () => {
      invoked += 1;
    },
  });
  native.tui.keys.add("ctrl+k m", "probe");
  frame.key("ctrl+k m");
  assertEquals(invoked, 1);
  assertEquals(surface.tui.keys.pending(), "");
});

test("a transcript search closes when its widget leaves the tree", () => {
  const { frame, editor, surface, visibility } = reader();
  using _owned = frame;
  frame.key("/");
  assert(surface.tui.focused !== editor);
  visibility.transcript = false;
  frame.draw();
  assert(surface.tui.focused === editor);
});

test("transcript marks stay with their document when the view changes sessions", () => {
  const { frame, view } = reader();
  using _owned = frame;
  const original = view.document;
  frame.key("g g w m a");
  view.setDocument({ ...original, id: "another-session" });
  frame.draw();
  frame.key("g g ` a");
  assertEquals(view.caret, { item: "a", section: "body", offset: 0 });
  view.setDocument(original);
  frame.draw();
  frame.key("g g ` a");
  assertEquals(view.caret, { item: "a", section: "body", offset: 6 });
});
