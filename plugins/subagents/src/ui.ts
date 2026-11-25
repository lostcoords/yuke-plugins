import { type ChatService, composerRows } from "yuke:chat";
import type { PluginContext } from "yuke:plugins";
import type { SessionId } from "yuke:protocol";
import { type KeyEvent, strokeOf, type Tui } from "yuke:tui";
import { type ListEntry, listRows, SHOWN } from "./list.ts";
import { openModelDialog } from "./model-dialog.ts";
import type { ModelList } from "./models.ts";

/** A running subagent, as the terminal interface needs it. */
export interface ListedRun extends ListEntry {
  readonly id: SessionId;
  /** Stop its job. */
  readonly stop: () => Promise<void>;
}

/** What the interface reads of the plugin. */
export interface UiSource {
  /** The running subagents of `parent`, oldest first. */
  readonly running: (parent: SessionId) => readonly ListedRun[];
  /** The label of the child session `session`, when it is a subagent. */
  readonly label: (session: SessionId) => string | undefined;
  /** Whether any subagent runs. */
  readonly anyRunning: () => boolean;
}

const HINT = "↓↑ move · enter open · x stop · esc back";

/**
 * Show the list of the subagents of the root below the composer, its selection, and the label of a shown subagent.
 * Return the function that draws them again.
 */
export function installUi(ctx: PluginContext, tui: Tui, models: ModelList, source: UiSource): () => void {
  const chat: ChatService = ctx.get("chat");
  let selected: { readonly parent: SessionId; index: number } | undefined;
  let tick: (() => void) | undefined;
  let removeHint: (() => void) | undefined;

  const leave = (): void => {
    selected = undefined;
    removeHint?.();
    removeHint = undefined;
    tui.requestFrame();
  };

  const redraw = (): void => {
    tick?.();
    tick = undefined;
    if (selected !== undefined) {
      const count = Math.min(SHOWN, source.running(selected.parent).length);
      if (count === 0) leave();
      else selected.index = Math.min(selected.index, count - 1);
    }
    tui.requestFrame();
    // The times of the list move each second.
    if (source.anyRunning()) tick = tui.addTimer(1000, redraw);
  };

  chat.addChildLabel(source.label);

  tui.commands.add({
    name: "models",
    slash: "subagents:models",
    description: "Choose the models of subagents",
    run: () => openModelDialog(tui, models, (text) => ctx.notify("error", text)),
  });

  // The list belongs to the root, so it stays while a subagent shows.
  chat.addComposerView("below", (_mount, view) => {
    const rowsAt = (width: number): string[] =>
      view.rootId === undefined ? [] : listRows(source.running(view.rootId), width, tui.now());
    return {
      heightFor: (width) => rowsAt(width).length,
      draw: (canvas) => {
        const chosen = selected !== undefined && selected.parent === view.rootId ? selected.index : undefined;
        // A short place scrolls, so the selected row stays in sight.
        const first = Math.max(0, (chosen ?? 0) - canvas.height + 1);
        for (const [at, text] of rowsAt(canvas.width)
          .slice(first, first + canvas.height)
          .entries()) {
          canvas.text(0, at, text, first + at === chosen ? { fg: "accent", bold: true } : { dim: true });
        }
      },
    };
  });

  chat.addComposerView("above", (_mount, view) =>
    composerRows(() => {
      const root = view.rootId;
      // A turn of the root shows its own working row, and a shown subagent shows its own transcript.
      const count = root === undefined || view.sessionId !== root || view.running ? 0 : source.running(root).length;
      if (count === 0) return [];
      return [{ text: `Waiting for ${count} ${count === 1 ? "subagent" : "subagents"}`, style: { dim: true } }];
    }),
  );

  /** Take a key while a row is selected. A key with no meaning here leaves the selection and goes on to the composer. */
  const selectedKey = (event: KeyEvent): boolean => {
    if (selected === undefined) return false;
    // The chat can show another session, as after `chat.show`, and the selection stays with its list.
    if (chat.sessionId() !== selected.parent) {
      leave();
      return false;
    }
    const run = source.running(selected.parent)[selected.index];
    switch (strokeOf(event)) {
      case "down":
        selected.index = Math.min(selected.index + 1, Math.min(SHOWN, source.running(selected.parent).length) - 1);
        tui.requestFrame();
        return true;
      case "up":
        if (selected.index === 0) leave();
        else selected.index -= 1;
        tui.requestFrame();
        return true;
      case "enter":
        leave();
        if (run !== undefined) {
          chat
            .show(run.id)
            .catch((error: unknown) => ctx.notify("error", `the subagent did not open: ${String(error)}`));
        }
        return true;
      case "x":
        run?.stop().catch((error: unknown) => ctx.notify("error", `the subagent did not stop: ${String(error)}`));
        return true;
      case "esc":
        leave();
        return true;
      default:
        leave();
        return false;
    }
  };

  chat.addViewWatcher((view, signal) => {
    const composer = view.composer;
    const extension = composer.extend(signal);
    extension.addKeyHandler(selectedKey, "beforeKeymap");
    // This phase comes after the keymap, so a browse of older messages keeps its Down.
    extension.addKeyHandler((event) => {
      if (strokeOf(event) !== "down") return false;
      const parent = view.rootId;
      if (parent === undefined || source.running(parent).length === 0) return false;
      if (composer.rows.point(composer.caret)?.row !== composer.rows.count - 1) return false;
      selected = { parent, index: 0 };
      removeHint = tui.status.set("subagents", { text: HINT, side: "left", order: 0 });
      tui.requestFrame();
      return true;
    });
  });

  return redraw;
}
