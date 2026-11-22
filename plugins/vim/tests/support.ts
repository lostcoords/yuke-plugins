import { createFrame, createHost } from "yuke:test";
import { type EditorSpan, type EditorState, TextEditor, type View } from "yuke:tui";
import { apply } from "../src/index.ts";

/** Load the plugin in a host over a frame that lays out `editors`. `await using` closes the host, then the frame. */
export async function harness(editors: readonly TextEditor[]) {
  const root: View = {
    draw() {},
    initialFocus: editors[0],
    layout: (size) =>
      editors.map((editor, index) => ({
        view: editor,
        rect: { column: 2, row: 1 + index * 5, width: size.width - 4, height: 4 },
      })),
  };
  const frame = createFrame({ width: 48, height: 12 }, () => root);
  const host = await createHost({ frame, plugins: [{ name: "vim", apply }] });
  const surface = frame.surface("test");
  frame.draw();
  return {
    frame,
    host,
    surface,
    async [Symbol.asyncDispose]() {
      await host.close();
      frame[Symbol.dispose]();
    },
  };
}

export async function composer(text = "", caret = 0, spans: readonly EditorSpan[] = []) {
  const submitted: EditorState[] = [];
  const editor = new TextEditor({
    role: "composer",
    appearance: { cursorShape: "bar" },
    state: { text, selection: { anchor: caret, head: caret }, spans },
    onSubmit: (state) => submitted.push(state),
  });
  const fixture = await harness([editor]);
  return Object.assign(fixture, { editor, submitted });
}
