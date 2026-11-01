import type { Rect, Size, Tui, View } from "yuke:tui";

export function installStyles(tui: Tui): void {
  tui.styles.set("btw.panel", { fg: "fg", bg: "bg" });
  tui.styles.set("btw.title", { link: "chat.title" });
  tui.styles.set("btw.question", { link: "chat.meta" });
  tui.styles.set("btw.working", { link: "chat.hint" });
  tui.styles.set("btw.hint", { link: "chat.meta" });
}

/** Blank the narrow gutters so fragments of the live main chat cannot show through. */
export function panelView(view: View): View {
  return {
    initialFocus: view.initialFocus,
    draw: (canvas) => canvas.fill(0, 0, canvas.width, canvas.height, { fg: "fg", bg: "bg" }),
    layout: (size) => {
      const margin = size.width >= 80 ? 2 : 0;

      return [
        { view, rect: { column: margin, row: 0, width: size.width - margin * 2, height: size.height } },
      ];
    },
  };
}

export function panelRect(size: Size): Rect {
  const height = Math.min(size.height, Math.max(9, Math.ceil(size.height * 0.6)));

  return { column: 0, row: size.height - height, width: size.width, height };
}
