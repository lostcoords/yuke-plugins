/**
 * The plugin `speed`. The status bar shows the output speed of the model in the session of the focused pane, in tokens
 * per second. A streaming answer shows an estimate, and its end shows the count of the provider.
 */

import type { PluginContext } from "yuke:plugins";
import { Meter } from "./meter.ts";

/** The estimate of a streaming answer changes at this interval. */
const REFRESH_MS = 500;

export function apply(ctx: PluginContext): undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;
  const chat = ctx.get("chat");
  const meters = new Map<string, Meter>();
  let removeItem: (() => void) | undefined;
  let shown: string | undefined;
  let cancelTimer: (() => void) | undefined;

  const focused = (): Meter | undefined => {
    const view = tui.panes.activePane?.view;
    const id = view === undefined ? undefined : chat.sessionIdOf(view);
    return id === undefined ? undefined : meters.get(id);
  };
  const show = (): void => {
    const meter = focused();
    const text = meter?.text(tui.now());
    if (text !== shown) {
      shown = text;
      removeItem?.();
      removeItem = text === undefined ? undefined : tui.status.set("speed", { text, side: "right", order: 15 });
    }
    cancelTimer?.();
    cancelTimer = meter?.streaming === true ? tui.addTimer(REFRESH_MS, show) : undefined;
  };

  ctx.addListener("session.update", (data) => {
    let meter = meters.get(data.sessionId);
    if (meter === undefined) {
      if (data.update.kind !== "draftStarted") return;
      meter = new Meter();
      meters.set(data.sessionId, meter);
    }
    const streaming = meter.streaming;
    meter.record(data.update, tui.now());
    // A delta changes only the estimate, and the timer shows it, so only a start or an end shows at once.
    if (meter.streaming !== streaming && meter === focused()) show();
  });
  chat.addChangeListener(show);
  tui.addFocusListener(show);
  ctx.signal.addEventListener("abort", () => cancelTimer?.(), { once: true });
  return undefined;
}
