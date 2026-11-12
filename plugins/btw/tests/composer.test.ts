import type { PluginContext, ServiceOf, Services } from "yuke:plugins";
import { assert, createFrame, createHost, equal, test } from "yuke:test";
import type { MouseEvent } from "yuke:tui";
import { apply } from "../src/index.ts";

for (const width of [32, 100]) {
  test(`the composer grows with its draft, keeps padding and cursor alignment, and contracts at width ${width}`, async () => {
    using frame = createFrame({ width, height: 30 });
    const surface = frame.surface("btw");
    await using host = await createHost({
      plugins: [
        {
          name: "chat",
          provides: ["chat"],
          apply: (ctx) => {
            ctx.provide("chat", {
              session: () => undefined,
              show: async () => {},
              addChangeListener: () => () => {},
              addPaneWatcher: () => () => {},
              addCompletionProvider: () => () => {},
              addComposerView: () => () => {},
              setPresentation: () => () => {},
              addReadOnly: () => () => {},
              setComposerFrame: () => () => {},
              setEmptyView: () => () => {},
            });
          },
        },
        {
          name: "btw",
          uses: ["chat"],
          apply: (ctx) => {
            surface.tui.styles.add({
              "chat.title": { fg: "accent", bold: true },
              "chat.hint": { fg: "accent" },
              "chat.meta": { dim: true },
            });
            const get = <K extends keyof Services & string>(name: K): ServiceOf<K> =>
              name === "tui" ? (surface.tui as ServiceOf<K>) : ctx.get(name);
            return apply({ ...ctx, get } satisfies PluginContext);
          },
        },
      ],
    });
    surface.tui.panes.split(() => ({ draw() {} }));
    surface.tui.commands.run("btw:ask");
    frame.draw();
    const input = surface.tui.widgets.list().find((mount) => mount.widget === surface.tui.focused)?.widget;
    assert(input?.kind === "editor");
    const lines = () => frame.frame.cells.map((row) => row.map((cell) => cell.text).join(""));
    const fieldHeight = () => {
      const rule = lines().findLastIndex((line) => /^─+$/.test(line.trim()));
      assert(rule >= 0, "A plain rule separates the input from the answer.");
      return frame.frame.height - rule - 2;
    };
    const clear = () => {
      input.selection = { anchor: 0, head: input.state.text.length };
      frame.key("backspace");
      equal(input.state.text, "");
      equal(fieldHeight(), 1, "Clearing the draft restores a single input row.");
    };

    equal(fieldHeight(), 1, "An empty composer must not reserve three content rows.");
    const placeholderRow = lines().findIndex((line) => line.includes("Ask a side question"));
    const row = frame.frame.cells[placeholderRow];
    assert(row !== undefined);
    const prompt = row.findIndex((cell) => cell.text === "›");
    const placeholder = lines()[placeholderRow]?.indexOf("Ask a side question");
    assert(placeholder !== undefined);
    equal(frame.frame.cursor?.row, placeholderRow);
    equal(frame.frame.cursor?.column, placeholder - 1, "The block cursor belongs before the placeholder.");
    equal(row[placeholder - 1]?.text, " ");
    equal(input.state.text, "", "Cursor clearance must not insert spaces into the actual draft.");
    equal(row[prompt - 1]?.style.bg, undefined, "The field has one cell of inner left padding.");
    equal(row[prompt - 2]?.style.bg, undefined, "The field and its surroundings share one background.");
    const right = row.length - (width >= 80 ? 2 : 0) - 2;
    equal(row[right]?.text, " ");
    equal(row[right]?.style.bg, undefined, "The field has one cell of inner right padding.");
    equal(row[right + 1]?.style.bg, undefined);
    const footer = lines().at(-1) ?? "";
    assert(footer.includes("Enter send") && footer.includes("Esc close"), footer);
    assert(!/copy|Tab focus|scroll/.test(footer), "Only primary action hints belong in the footer.");
    if (width >= 80) assert(footer.includes("Ctrl+R history"), footer);

    frame.paste("x".repeat(27));
    equal(fieldHeight(), width === 32 ? 2 : 1, "Only a narrow field wraps this draft.");
    frame.resize({ width: width === 32 ? 100 : 32, height: 30 });
    equal(fieldHeight(), width === 32 ? 1 : 2, "Resizing reflows the draft using the actual padded width.");
    frame.resize({ width, height: 30 });
    clear();
    frame.paste("first");
    frame.key("shift+enter");
    frame.paste("second");
    equal(fieldHeight(), 2, "A newline adds a content row.");
    frame.key("ctrl+j");
    frame.paste("third");
    equal(fieldHeight(), 3);
    frame.key("alt+enter");
    frame.paste("fourth");
    equal(fieldHeight(), 3, "Longer drafts scroll within the bounded composer.");
    equal(frame.frame.cursor?.row, frame.frame.height - 2, "The caret stays visible above the footer.");
    clear();

    frame.paste("abcdef");
    const cursor = frame.frame.cursor;
    assert(cursor !== undefined);
    const mouse: MouseEvent = {
      type: "mouse",
      action: "press",
      button: "left",
      column: cursor.column - 4,
      row: cursor.row,
      modifiers: { shift: false, alt: false, ctrl: false, super: false, hyper: false, meta: false },
    };
    frame.key("tab");
    frame.mouse(mouse);
    frame.mouse({ ...mouse, action: "release" });
    equal(surface.tui.focused, input);
    frame.paste("X");
    equal(input.state.text, "abXcdef", "Mouse placement must include both the field and desktop insets.");
    equal(host.requests.length, 0, "Editing a draft must not contact a model.");
  });
}
