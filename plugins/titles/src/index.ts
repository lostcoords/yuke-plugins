import type { PluginContext } from "yuke:plugins";

import { openModelDialog } from "./model-dialog.ts";
import { Titles } from "./titles.ts";

export async function apply(ctx: PluginContext): Promise<() => Promise<void>> {
  const titles = new Titles(ctx);
  const tui = ctx.get("tui");

  if (tui !== undefined) {
    tui.commands.add({
      name: "settings",
      description: "Choose session title models and their fallback order",
      run: async () => {
        await openModelDialog(tui, titles.models, (text) => ctx.notify("error", text)).catch((error: unknown) =>
          ctx.notify("error", `The title settings did not open: ${String(error)}`),
        );
      },
    });

    tui.commands.add({
      name: "regenerate",
      description: "Regenerate this session's title from its first message",
      run: async () => {
        const pane = tui.panes.active?.view;
        const id = pane === undefined ? undefined : ctx.get("chat").session(pane);

        if (id === undefined) {
          ctx.notify("info", "Open a session before generating a title.");
          return;
        }

        await titles
          .regenerate(id)
          .catch((error: unknown) => ctx.notify("error", `The session title did not change: ${String(error)}`));
      },
    });

    try {
      if ((await titles.models.read()).models.length === 0) {
        ctx.notify("info", "Choose a title model with titles:settings. Automatic titles stay off until then.");
      }
    } catch (error) {
      ctx.notify("error", `The title settings did not load: ${String(error)}`);
    }
  }

  return () => titles.close();
}
