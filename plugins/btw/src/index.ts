import type { PluginContext } from "yuke:plugins";

import { History } from "./history.ts";
import { browseHistory } from "./history-ui.ts";
import { openPanel } from "./panel.ts";
import { installStyles } from "./style.ts";

export { session } from "./requests.ts";

export function apply(ctx: PluginContext): undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;

  installStyles(tui);
  const history = new History(ctx.dataDir);

  const activeSessionId = (): string | undefined => ctx.get("chat").sessionId();

  tui.commands.add({
    name: "ask",
    slash: "btw",
    argumentHint: "<question>",
    description: "Ask a parallel side question using the main round's cache",
    // A question without a round keeps its draft.
    run: (args) =>
      openPanel(ctx, tui, history, activeSessionId(), typeof args === "string" ? args.trim() : "") ? undefined : false,
  });

  tui.commands.add({
    name: "history",
    slash: "btw:history",
    description: "Browse saved side answers",
    run: () => {
      const sessionId = activeSessionId();
      browseHistory(ctx, tui, history, sessionId, (entry) => {
        openPanel(ctx, tui, history, sessionId, entry);
      });
    },
  });

  tui.keys.add("ctrl+k b", "ask");
}
