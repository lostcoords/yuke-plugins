import type { PluginContext } from "yuke:plugins";
import { TextEditor } from "yuke:tui";
import { ComposerEditor } from "./composer.ts";
import { Registers } from "./registers.ts";

export function apply(ctx: PluginContext): (() => void) | undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;

  const registers = new Registers();
  const composer = new ComposerEditor(ctx, tui, registers);
  const stopWidgets = tui.widgets.watch((mount) => {
    const editor = mount.widget;
    if (editor.kind !== "editor" || editor.role !== "composer") return;
    return composer.bind(editor, mount.signal);
  });
  const stopFocus = tui.onFocus((change) => {
    if (change.previous instanceof TextEditor) composer.cancel(change.previous);
    composer.updateStatus();
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
