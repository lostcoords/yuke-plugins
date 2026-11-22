import type { ChatReadOnly, ChatService } from "yuke:chat";
import type { PluginContext } from "yuke:plugins";
import type { SessionId } from "yuke:protocol";
import { fit, type KeyEvent, strokeOf, type Tui, type View } from "yuke:tui";
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
  /** Whether a turn of `parent` runs. */
  readonly busy: (parent: SessionId) => boolean;
  /** The read-only row of `session`, when it is a subagent. */
  readonly readOnly: (session: SessionId) => ChatReadOnly | undefined;
  /** The parents with a running subagent. */
  readonly anyRunning: () => boolean;
}

const HINT = "↓↑ move · enter open · x stop · esc back";

/** Show the list in a chat pane, its selection, and the view of a subagent. Return the function that draws them again. */
export function installUi(ctx: PluginContext, tui: Tui, models: ModelList, source: UiSource): () => void {
  const chat: ChatService = ctx.get("chat");
  let selected: { readonly pane: View; readonly parent: SessionId; index: number } | undefined;
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

  chat.addReadOnly(source.readOnly);

  tui.commands.add({
    name: "models",
    slash: "subagents:models",
    description: "Choose the models of subagents",
    run: async () => {
      const fail = (text: string): void => ctx.notify("error", text);
      await openModelDialog(tui, models, fail).catch((error: unknown) => fail(String(error)));
    },
  });

  // A selection belongs to its pane, so a key in another pane never acts on it.
  tui.addFocusListener(() => {
    if (selected !== undefined) leave();
  });

  chat.addComposerView("below", (_mount, pane) => {
    const rowsAt = (width: number): string[] =>
      pane.sessionId === undefined ? [] : listRows(source.running(pane.sessionId), width, tui.now());
    return {
      heightFor: (width) => rowsAt(width).length,
      draw: (canvas) => {
        const chosen = selected?.pane === pane.view && selected.parent === pane.sessionId ? selected.index : undefined;
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

  chat.addComposerView("above", (_mount, pane) => {
    const waiting = (): number =>
      pane.sessionId === undefined || source.busy(pane.sessionId) ? 0 : source.running(pane.sessionId).length;
    return {
      heightFor: () => (waiting() === 0 ? 0 : 1),
      draw: (canvas) => {
        const count = waiting();
        if (count === 0) return;
        const text = `Waiting for ${count} ${count === 1 ? "subagent" : "subagents"}`;
        const shown = fit(text, canvas.width) === text.length ? text : `${text.slice(0, fit(text, canvas.width - 1))}…`;
        canvas.text(0, 0, shown, { dim: true });
      },
    };
  });

  /** Take a key while a row is selected. A key with no meaning here leaves the selection and goes on to the composer. */
  const selectedKey = (event: KeyEvent): boolean => {
    if (selected === undefined) return false;
    // The pane can show another session, as after `chat.show`, and the selection stays with its list.
    if (chat.sessionIdOf(selected.pane) !== selected.parent) {
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

  chat.addPaneWatcher((pane, signal) => {
    const composer = pane.composer;
    const extension = composer.extend(signal);
    extension.addKeyHandler(selectedKey, "beforeKeymap");
    // This phase comes after the keymap, so a browse of older messages keeps its Down.
    extension.addKeyHandler((event) => {
      if (strokeOf(event) !== "down") return false;
      const parent = pane.sessionId;
      if (parent === undefined || source.running(parent).length === 0) return false;
      if (composer.rows.point(composer.caret)?.row !== composer.rows.count - 1) return false;
      selected = { pane: pane.view, parent, index: 0 };
      removeHint = tui.status.set("subagents", { text: HINT, side: "left", order: 0 });
      tui.requestFrame();
      return true;
    });
  });

  return redraw;
}
