import type { PluginContext } from "yuke:plugins";
import type { View } from "yuke:tui";

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
      ctx.notify("info", NO_ROUND);
      return false;
    }

    openPanel(ctx, tui, history, sessionId, question);
    return true;
  };

  tui.commands.add({
    name: "ask",
    slash: "btw",
    argumentHint: "<question>",
    description: "Ask a parallel side question using the main round's cache",
    // A question without a round keeps its draft.
    run: (args) => (start(tui.panes.active?.view, typeof args === "string" ? args : "") ? undefined : false),
  });

  tui.commands.add({
    name: "history",
    slash: "btw:history",
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
}
