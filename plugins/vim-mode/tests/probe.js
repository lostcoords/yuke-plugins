//! Exercise the actual plugin with Yuke's public TUI objects and no model request.
import apply from "../index.js";
import { wordMotion } from "../word-motions.js";
import { ChatView, Transcript } from "yuke:chat";
import { Session } from "yuke:session";
import { events } from "yuke";
import { quit } from "yuke:ui";

/** @param {unknown} actual @param {unknown} expected @returns {void} */
function equal(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Run the key and shared-register invariants. No TUI skips them. An invariant failure throws. @param {import("yuke").Context} ctx */
export default function (ctx) {
  const tui = ctx.get("tui");
  if (!tui) { apply(ctx); return; }
  /** @type {import("yuke").Release[]} */
  const releases = [];
  const own = ctx.own;
  ctx.own = (release) => { releases.push(release); return own.call(ctx, release); };
  try { apply(ctx); } finally { ctx.own = own; }
  ctx.once("ui.started", () => {
    const root = tui.root;
    const view = root.active;
    if (!(view instanceof ChatView)) throw new Error("The shell did not create a chat pane");
    const c = view.composer;

    /** @param {string} stroke @param {number} [mods] @returns {void} */
    function key(stroke, mods = 0) {
      const named = stroke === "esc" || stroke === "tab" || stroke === "backspace";
      root.onEvent({ type: "key", event: "press", code: named ? stroke : "char", char: named ? "" : stroke, shifted: "", baseLayout: "", text: named || mods ? "" : stroke, mods });
    }
    /** @param {string} text @param {number} [at] @returns {void} */
    function draft(text, at = 0) {
      /** @type {NonNullable<typeof tui>} */ (tui).command.perform("vim-mode:normal");
      c.input.setText(text);
      c.input.caret = at;
      key("esc");
    }

    // Insert handling works before the first Escape or mode command.
    c.input.setText("hola\nchao"); key("w", 4);
    equal(c.input.text, "hola\n"); equal(c.input.caret, 5);

    // Clipboard writes follow yanks, while deletes, puts, and black-hole yanks stay internal.
    /** @type {string[]} */
    const clipboardWritesOwn = [];
    const releaseClipboard = ctx.on("clipboard.copied", ev => {
      equal(ev.bytes > 0, true);
      clipboardWritesOwn.push(ev.text);
    });
    draft("first\nsecond"); key("y"); key("y");
    equal(clipboardWritesOwn.length, 1); equal(clipboardWritesOwn[0], "first");
    key("p"); equal(c.input.text, "first\nfirst\nsecond"); equal(clipboardWritesOwn.length, 1);
    draft("red blue"); key('"'); key("a"); key("y"); key("i"); key("w");
    key("w"); key('"'); key("A"); key("y"); key("i"); key("w");
    equal(clipboardWritesOwn.length, 3); equal(clipboardWritesOwn[1], "red"); equal(clipboardWritesOwn[2], "blue");
    draft("X"); key('"'); key("a"); key("P"); equal(c.input.text, "redblueX"); equal(clipboardWritesOwn.length, 3);
    draft("a👩‍💻b", 1); key("v"); key("y");
    equal(clipboardWritesOwn.length, 4); equal(clipboardWritesOwn[3], "👩‍💻");
    draft("red blue"); key("w"); key("x"); key("P"); equal(c.input.text, "red blue");
    key('"'); key("_"); key("y"); key("i"); key("w"); equal(clipboardWritesOwn.length, 4);
    key("c"); key("i"); key("w"); key("Z"); key("esc"); equal(clipboardWritesOwn.length, 4);

    draft("alpha beta");
    key("w"); equal(c.input.caret, 6);
    key("b"); equal(c.input.caret, 0);
    key("e"); equal(c.input.caret, 4);
    key("i"); key("Z"); equal(c.input.text, "alphZa beta");
    key("esc"); key("x"); equal(c.input.text, "alpha beta");
    key("p"); equal(c.input.text, "alphaZ beta");

    draft("first\nsecond");
    key("d"); key("d"); equal(c.input.text, "second");
    key("P"); equal(c.input.text, "first\nsecond");
    key("c"); key("c"); key("X"); equal(c.input.text, "X\nsecond");

    // Empty first and last lines have real zero-width carets, and append does not cross their newline.
    draft("\nsecond"); key("a"); key("X"); equal(c.input.text, "X\nsecond");
    draft("first\n", 6); key("i"); key("X"); equal(c.input.text, "first\nX");
    draft("first\r\nsecond"); key("A"); key("X"); equal(c.input.text, "firstX\r\nsecond");
    draft("first\r\nsecond"); key("d"); key("d"); equal(c.input.text, "second");
    draft("first\r\nsecond", 7); key("d"); key("d"); equal(c.input.text, "first");
    draft("a👩‍💻e\u0301", 1); key("x"); equal(c.input.text, "ae\u0301");
    key("P"); equal(c.input.text, "a👩‍💻e\u0301");
    draft("🇯x🇵", 2); key("x"); equal(c.input.text, "🇯🇵"); equal(c.input.caret, 0);
    draft("🇯x🇵", 2); key("s"); equal(c.input.caret, 0); key("X"); equal(c.input.text, "X🇯🇵");
    draft("abc", 2); key("s"); key("X"); equal(c.input.text, "abX");

    // Insert Ctrl+W keeps the line break and stays in the insert undo group.
    draft("hola\nchao", 8); key("A"); key("w", 4);
    equal(c.input.text, "hola\n"); equal(c.input.caret, 5);
    key("esc"); key("u"); equal(c.input.text, "hola\nchao");
    draft("hola\n\tchao  ", 10); key("A"); key("w", 4);
    equal(c.input.text, "hola\n\t"); equal(c.input.caret, 6);
    draft("hola\r\nchao", 9); key("A"); key("w", 4);
    equal(c.input.text, "hola\r\n"); equal(c.input.caret, 6);
    draft("hola\ne\u0301👩‍💻", 7); key("A"); key("w", 4);
    equal(c.input.text, "hola\ne\u0301"); equal(c.input.caret, 7);

    // A typed character can join the next cluster without leaving an interior caret.
    draft("\u0301x"); key("i"); key("e"); equal(c.input.caret, 2);
    key("backspace"); equal(c.input.text, "x");
    draft("a b"); key("d"); key("tab"); equal(view.focus, "transcript");
    key("tab"); key("w"); equal(c.input.text, "a b"); equal(c.input.caret, 2);

    // Character replacement and visual repeat count complete graphemes, not source UTF-16 units.
    draft("ab 👩‍💻🇯🇵"); key("2"); key("r"); key("X"); key("w"); key(".");
    equal(c.input.text, "XX XX");
    draft("ab 👩‍💻🇯🇵"); key("v"); key("l"); key("d"); key("w"); key(".");
    equal(c.input.text, " ");
    draft("abc", 1); const blob = { hash: "test", mime: "image/png", bytes: 1 };
    if (!c.attach(1, "b", blob)) throw Error("attachment setup");
    key("x"); equal(c.spans.length, 0); key("u");
    equal(c.input.text, "abc"); equal(c.spans.length, 1);
    if (!("blob" in c.spans[0]) || c.spans[0].blob.hash !== "test") throw Error("undo image metadata");

    // The word rules distinguish punctuation and preserve Indic and combining clusters.
    equal(wordMotion("a.. b", 0, 0), 1);
    equal(wordMotion("a.. b", 1, 0), 4);
    equal(wordMotion("a.. b", 4, -1), 1);
    equal(wordMotion("a.. b", 0, 1), 2);
    equal(wordMotion("क्ष e\u0301", 0, 0), 4);
    equal(wordMotion("क्ष e\u0301", 6, -1), 4);
    equal(wordMotion("क्ष e\u0301", 0, 1), 4);
    const wideSlice = "界".repeat(1500).slice(100, 1100);
    equal(wordMotion(wideSlice, 0, 0), 1000);
    equal(wordMotion(wideSlice, 1000, -1), 0);
    equal(wordMotion(wideSlice, 0, 1), 999);
    const longCluster = "xa" + "\u0301".repeat(300) + "y";
    equal(wordMotion(longCluster, 0, 1), 302);

    view.transcript = new Transcript({ partsOf: () => [{ type: "text", id: 0, text: "alpha 界e\u0301\nbravo" }] });
    const t = view.transcript;
    t.setOutline([{ id: 101, type: "assistant" }], null);
    t.rows(40, 0, 100);
    key("tab"); equal(view.focus, "transcript");
    key("g"); key("g"); equal(t.caret?.col, 0);
    key("v"); key("l"); key("y"); equal(t.selection, null);
    equal(clipboardWritesOwn.length, 5); equal(clipboardWritesOwn[4], "al");
    key("tab"); equal(view.focus, "composer");
    draft("X"); key("p"); equal(c.input.text, "Xal"); equal(clipboardWritesOwn.length, 5);
    key("tab"); key("g"); key("g"); key('"'); key("_"); key("y"); key("y");
    equal(clipboardWritesOwn.length, 5);
    key("tab"); draft("X"); key("p"); equal(c.input.text, "Xal");
    releaseClipboard();

    // A second pane reads the same register, but each pane keeps its own mode and selection.
    const other = new ChatView(new Session());
    if (!tui.split("row", other)) throw new Error("The shell did not split");
    other.composer.input.setText("Y");
    other.composer.input.caret = 0;
    key("esc"); key("p"); equal(other.composer.input.text, "Yal");
    root.focusView(view);
    key("tab"); key("g"); key("g"); key("y"); key("y");
    key("tab"); draft("X"); key("p"); equal(c.input.text, "X\nalpha 界e\u0301 bravo");
    key("tab"); key("g"); key("y");
    key("tab"); draft("X"); key("p"); equal(c.input.text, "X\nalpha 界e\u0301\nbravo");
    key("tab"); key("v"); key("l");
    key("tab"); equal(t.selection, null);
    key("tab");
    t.setOutline([], null);
    key("j"); equal(t.caret, null);
    equal(events.bail("chat.cursor", view), undefined);
    key("tab");

    // Scrolling from an ASCII row to an emoji row preserves a cell column, not an interior UTF-16 offset.
    view.transcript = new Transcript({ partsOf: () => [{ type: "text", id: 0, text: "```text\nABCDE\n" + "👩‍💻x\n".repeat(50) + "```" }] });
    const scrolled = view.transcript;
    scrolled.setOutline([{ id: 102, type: "assistant" }], null);
    scrolled.rows(39, 0, 100);
    key("tab"); key("g"); key("g"); key("l"); key("l"); key("l");
    root.draw();
    scrolled.pager.toBottom(); root.invalidatePaint(); root.draw();
    equal(scrolled.caret?.col, 5);
    key("h"); equal(scrolled.caret?.col, 0);
    key("tab");

    // A line deletion can merge the surrounding clusters, so the resulting caret snaps to a boundary.
    draft("a\n\u0301", 2); key("d"); key("d");
    equal(c.input.text, "a"); equal(c.input.caret, 0);

    // The release clears every visited transcript, including a pane that is not active.
    root.focusView(other); key("tab");
    for (const release of releases) release();
    equal(view.transcript.caret, null);
    equal(view.transcript.selection, null);
    equal(view.focus, "composer");
    equal(other.transcript.caret, null);
    equal(other.focus, "composer");
    ctx.print("vim-mode: key, Unicode, shared-register, and cleanup checks passed");
    quit();
  });
}
