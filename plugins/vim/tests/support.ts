import type { PluginContext } from "yuke:plugins";
import { assert, createFrame } from "yuke:test";
import { type EditorSpan, type EditorState, TextEditor, type View } from "yuke:tui";
import { apply } from "../src/index.ts";
import type { ComposerVim } from "../src/service.ts";

export function harness(editors: readonly TextEditor[]) {
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
  const surface = frame.surface("vim");
  let vim: ComposerVim | undefined;
  apply({
    get: (name: string) => {
      assert(name === "tui", `Unexpected service: ${name}`);
      return surface.tui;
    },
    provide: (name: string, service: ComposerVim) => {
      assert(name === "composer-vim");
      vim = service;
    },
    signal: surface.signal,
    notify() {},
  } as unknown as PluginContext);
  frame.draw();
  assert(vim !== undefined);
  return { frame, surface, vim };
}

export function composer(text = "", caret = 0, spans: readonly EditorSpan[] = []) {
  const submitted: EditorState[] = [];
  const editor = new TextEditor({
    role: "composer",
    appearance: { cursorShape: "bar" },
    state: { text, selection: { anchor: caret, head: caret }, spans },
    onSubmit: (state) => submitted.push(state),
  });
  return { ...harness([editor]), editor, submitted };
}
