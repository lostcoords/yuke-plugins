import type { PluginContext } from "yuke:plugins";
import { assertEquals, createFrame, test } from "yuke:test";
import { apply } from "../src/index.ts";

test("the plugin adds solarized to the themes and leaves the choice to /themes", () => {
  using frame = createFrame({ width: 40, height: 4 });
  const tui = frame.surface("solarized").tui;
  apply({ get: (name: string) => (name === "tui" ? tui : undefined) } as unknown as PluginContext);
  assertEquals(tui.styles.themes(), ["default", "solarized"]);
  assertEquals(tui.styles.theme, "default");
});
