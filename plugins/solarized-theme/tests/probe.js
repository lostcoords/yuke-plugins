//! Read public styles in a disposable native terminal.
import { fs } from "yuke";
import { quit } from "yuke:ui";

/** Capture native theme state. The context owns listeners and keys. Registration failures throw. @param {import("yuke").Context} ctx */
export default function(ctx) {
  const tui = ctx.get("tui");
  if (!tui) return;
  const marker = ctx.root + "/generation.json";
  let generation = 0;
  const snapshot = () => ctx.print("SOLARIZED_SNAPSHOT " + JSON.stringify({
    generation, colors: tui.colors, background: tui.background, palette: tui.style.palette,
    thought: tui.style.resolve("TxThought"), user: tui.style.resolve("TxUser"),
    heading: tui.style.resolve("MdHeading"), panel: tui.style.resolve("UIPanel"),
  }));
  ctx.on("background.changed", () => { if (generation) setTimeout(snapshot, 0); });
  ctx.once("ui.started", async () => {
    try {
      const next = await fs.stat(marker) ? JSON.parse(await fs.readFile(marker)) + 1 : 1;
      await fs.writeFile(marker, JSON.stringify(next));
      if (!ctx.alive) return;
      generation = next;
      snapshot();
    } catch (error) { ctx.print("SOLARIZED_PROBE_FAILED", String(error)); quit(); }
  });
  tui.keymap.add({ "ctrl+g": "reload", "ctrl+q": quit });
}
