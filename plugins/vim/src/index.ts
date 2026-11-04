import type { PluginContext } from "yuke:plugins";
import type { TextPosition } from "yuke:tui";
import { strokeOf, TextEditor, TextView } from "yuke:tui";
import { ComposerEditor } from "./composer.ts";
import { Registers } from "./registers.ts";
import { TranscriptEditor } from "./transcript.ts";

/** Bind Vim to composers and transcripts. Return a cleanup, or undefined without a terminal interface. */
export function apply(ctx: PluginContext): (() => void) | undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;

  const registers = new Registers();
  const composer = new ComposerEditor(ctx, tui, registers);
  ctx.provide("composer-vim", composer);
  const transcripts = new Map<TextView, TranscriptEditor>();
  const marks = new Map<string, Map<string, TextPosition>>();
  const stopWidgets = tui.widgets.watch((mount) => {
    const editor = mount.widget;
    if (editor instanceof TextView && editor.role === "transcript") {
      const reader = new TranscriptEditor(ctx, tui, mount, editor, registers, marks);
      transcripts.set(editor, reader);
      return () => {
        reader.blur();
        transcripts.delete(editor);
      };
    }
    if (!(editor instanceof TextEditor) || editor.role !== "composer") return;
    const stop = composer.bind(editor, mount.signal);
    const extension = editor.extend(mount.signal);
    extension.onKey((event) => {
      if (strokeOf(event) !== "tab" || composer.mode(editor) === "insert" || composer.pending(editor)) return false;
      const transcript = tui.widgets
        .list()
        .find((entry) => entry.group === mount.group && entry.widget.role === "transcript")?.widget;
      return transcript === undefined ? false : tui.focus(transcript);
    }, "beforeKeymap");
    return () => {
      extension.dispose();
      stop();
    };
  });
  const stopFocus = tui.onFocus((change) => {
    if (change.previous instanceof TextEditor) composer.cancel(change.previous);
    if (
      (change.pane !== undefined ||
        (change.current instanceof TextEditor && change.current.role === "composer") ||
        (change.current instanceof TextView && change.current.role === "transcript")) &&
      change.previous instanceof TextView
    )
      transcripts.get(change.previous)?.blur();
    composer.updateStatus();
    if (change.current instanceof TextView) transcripts.get(change.current)?.focus();
  });
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    ctx.signal.removeEventListener("abort", stop);
    stopFocus();
    stopWidgets();
    registers.clear();
  };
  ctx.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
