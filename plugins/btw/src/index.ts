import type { PluginContext } from "yuke:plugins";
import { strokeOf, type View } from "yuke:tui";

import { History } from "./history.ts";
import { browseHistory } from "./history-ui.ts";
import { openPanel } from "./panel.ts";
import { cachedModel, NO_ROUND } from "./requests.ts";
import { installStyles } from "./style.ts";

export { session } from "./requests.ts";

export function apply(ctx: PluginContext): undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;

  installStyles(tui);
  const history = new History(ctx.dataDir);

  const start = (pane: View | undefined, question = ""): boolean => {
    const sessionId = pane === undefined ? undefined : ctx.get("chat").session(pane);

    if (question !== "" && cachedModel(sessionId) === undefined) {
      ctx.notify("warn", NO_ROUND);
      return false;
    }

    openPanel(ctx, tui, history, sessionId, question);
    return true;
  };

  tui.commands.add({
    name: "ask",
    description: "Ask a parallel side question using the main round's cache",
    run: () => {
      start(tui.panes.active?.view);
    },
  });

  tui.commands.add({
    name: "history",
    description: "Browse saved side answers",
    run: () => {
      const pane = tui.panes.active?.view;
      const sessionId = pane === undefined ? undefined : ctx.get("chat").session(pane);

      browseHistory(ctx, tui, history, sessionId, (entry) => {
        openPanel(ctx, tui, history, sessionId, entry);
      });
    },
  });

  tui.keys.bind("ctrl+k b", "ask");

  // Take /btw before the chat can queue it as main input, including during a running turn.
  tui.widgets.watch((mount) => {
    const editor = mount.widget;
    if (editor.kind !== "editor" || editor.role !== "composer") return;

    const extension = editor.extend(mount.signal);

    extension.onKey((event) => {
      if (strokeOf(event) !== "enter") return false;

      const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(editor.state.text);
      if (match === null) return false;

      if (start(mount.pane?.view, match[1]?.trim() ?? "")) {
        editor.reset({ text: "", spans: [], selection: { anchor: 0, head: 0 } });
      }

      return true;
    }, "beforeKeymap");

    return () => extension.dispose();
  });
}
