import type { PluginContext } from "yuke:plugins";
import { TextEditor } from "yuke:tui";
import { ComposerEditor } from "./composer.ts";
import { Registers } from "./registers.ts";

export function apply(ctx: PluginContext): undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return undefined;

  const registers = new Registers();
  const composer = new ComposerEditor(ctx, tui, registers);
  // The host removes the watcher and the listener at the stop of the plugin.
  tui.widgets.addWatcher((mount) => {
    const editor = mount.widget;
    if (editor.kind !== "editor" || editor.role !== "composer") return;
    return composer.bind(editor, mount.signal);
  });
  tui.addFocusListener((change) => {
    if (change.previousView instanceof TextEditor) composer.cancel(change.previousView);
    composer.updateStatus();
  });
  return undefined;
}
