//! A grapheme-safe Vim composer FSM and a source-anchored transcript cursor.
import { measure, prevGrapheme, nextGrapheme, caretAtCol, keys } from "yuke:ui";
import { ChatView } from "yuke:chat";
import { wordMotion, wordBigMotion } from "./word-motions.js";
import { ComposerEditor } from "./composer.js";
import { Registers } from "./registers.js";
import { TranscriptEditor } from "./transcript.js";
/** @typedef {ChatView["transcript"]} Transcript */
/** @typedef {{ id: number, row: number, col: number }} Position */
/** @typedef {{ cursor: Position | null, src: number, anchor: Position | null, visual: boolean, visualLines: boolean, goal: number | null }} VimState */
/** @typedef {{ x: number, y: number, visible: boolean }} Cursor */
/** @typedef {{ start: number, end: number }} WrapRow */
/** @typedef {{ kind: string, at: number, end: number }} Block */
/** @type {import("yuke:ui").Tui["root"]} */
let rootBorrow;
const register = new Registers();
/** @returns {ChatView | null} */
function focusedChat() { const view = rootBorrow.active; return view instanceof ChatView ? view : null; }
// The pane owns the region focus, so every binding sits on the atom the pane reports.
const TRANSCRIPT = "transcript";
const VISUAL = "transcript && vim_visual == on";
const NOT_VISUAL = "transcript && vim_visual != on";
const BASIC_KEYS = new Set(["W", "B", "E", "h", "l", "j", "k", "left", "right", "down", "up", "0", "home", "$", "end", "w", "b", "e", "J", "K", "v", "o", "esc", "enter"]);
const MOTION_KEYS = ["W", "B", "E", "h", "l", "j", "k", "left", "right", "down", "up", "0", "home", "$", "end", "G", "w", "b", "e", "}", "{", "J", "K"];

/** @type {WeakMap<ChatView, VimState>} */
const panes = new WeakMap();
/** @type {Set<ChatView>} */
const visited = new Set();

/** @param {ChatView} view @returns {VimState} */
function stateOf(view) {
  let s = panes.get(view);
  if (!s) {
    s = { cursor: null, src: -1, anchor: null, visual: false, visualLines: false, goal: null };
    panes.set(view, s);
    visited.add(view);
  }
  return s;
}

/** @param {Transcript} t @param {VimState} s @returns {void} */
function holdCol(t, s) {
  const cursor = /** @type {Position} */ (s.cursor);
  const body = t.rowTextAt(cursor.id, cursor.row);
  if (body.length === 0) return;
  if (cursor.col >= body.length) s.cursor = { ...cursor, col: prevGrapheme(body, body.length) };
}

// The transcript keeps the caret on its screen row across a rebuild, so each cursor change goes to it.
/** @param {Transcript} t @param {VimState} s @returns {void} */
function anchor(t, s) {
  t.caret = s.cursor;
  if (s.cursor) s.src = t.sourceAt(s.cursor);
}

/** @param {ChatView} view @param {VimState} s @returns {boolean} */
function place(view, s) {
  const t = view.transcript;
  anchor(t, s);
  rootBorrow.invalidate();
  return true;
}

// A rebuild moves rows under the cursor, so the cursor goes back to its source text. True when it moved.
/** @param {Transcript} t @param {VimState} s @returns {boolean} */
function reanchor(t, s) {
  if (!s.cursor || s.src < 0 || t.sourceAt(s.cursor) === s.src) return false;
  const pos = t.posAtSource(s.cursor.id, s.src);
  if (!pos) {
    s.cursor = null;
    s.src = -1;
    s.anchor = null;
    s.visual = false;
    s.visualLines = false;
    t.caret = null;
    t.clearSelection();
    return true;
  }
  s.cursor = pos;
  // The new position can map to other source text, so the anchor moves with it and the next draw finds no change.
  anchor(t, s);
  return true;
}

// The cursor stays on the screen, as in vim: a scroll that leaves it behind carries it to the nearest drawn row.
/** @param {Transcript} t @param {VimState} s @returns {boolean} */
function keepOnScreen(t, s) {
  const cursor = /** @type {Position} */ (s.cursor);
  const r = t.pager.rect();
  const top = r && t.posAt(r.x, r.y, false);
  const bottom = r && t.posAt(r.x, r.y + r.h - 1, false);
  if (!top || !bottom) return false;
  const at = { id: cursor.id, row: cursor.row, col: 0 };
  const edge = t.comparePos(at, top) < 0 ? top : t.comparePos(at, bottom) > 0 ? bottom : null;
  if (!edge) return false;
  carryToEdge(t, s, edge);
  anchor(t, s);
  syncSelection(t, s);
  return true;
}

// Only an off-screen cursor needs cell-column conversion, so the frame's common path builds no grapheme array.
/** @param {Transcript} t @param {VimState} s @param {Position} edge @returns {void} */
function carryToEdge(t, s, edge) {
  const cursor = /** @type {Position} */ (s.cursor);
  const goal = s.goal == null ? measure(t.rowTextAt(cursor.id, cursor.row).slice(0, cursor.col)) : s.goal;
  const body = t.rowTextAt(edge.id, edge.row);
  const col = caretAtCol(body, { start: 0, end: body.length }, goal);
  edge.col = col === body.length && col > 0 ? prevGrapheme(body, col) : col;
  s.cursor = edge;
}

// Every caller seeds only a state with no cursor.
/** @param {ChatView} view @param {VimState} s @returns {void} */
function seed(view, s) {
  const t = view.transcript;
  const r = t.pager.rect();
  for (let y = r ? r.y + r.h - 1 : -1; r && y >= r.y; y--) {
    const pos = t.posAt(r.x, y, false);
    if (pos && t.rowTextAt(pos.id, pos.row) !== "") {
      s.cursor = pos;
      anchor(t, s);
      return;
    }
  }
  toEnd(t, s, true);
  anchor(t, s);
}

/** @param {Transcript} t @param {Position | null} pos @returns {Cursor | null} */
function cursorOf(t, pos) {
  if (!pos) return null;
  const at = t.screenAt(pos);
  return at ? { x: at.x, y: at.y, visible: true } : { x: 0, y: 0, visible: false };
}

/** @param {Transcript} t @param {VimState} s @param {number} d @returns {boolean} */
function stepCol(t, s, d) {
  const cursor = /** @type {Position} */ (s.cursor);
  const body = t.rowTextAt(cursor.id, cursor.row);
  const col = d < 0 ? prevGrapheme(body, cursor.col) : nextGrapheme(body, cursor.col);
  if (col === cursor.col) return false;
  s.cursor = { id: cursor.id, row: cursor.row, col: Math.min(col, body.length) };
  return true;
}

/** @param {Transcript} t @param {VimState} s @param {number} d @returns {boolean} */
function stepRow(t, s, d) {
  const cursor = /** @type {Position} */ (s.cursor);
  let i = t.messageIndex(cursor.id);
  if (i < 0) return false;

  let r = cursor.row + d;
  let id = cursor.id;
  while (r < 0 || r >= t.rowCountOf(id)) {
    if (r < 0) {
      if (i === 0) return false;
      i--;
      id = t.messageIdAt(i);
      r += t.rowCountOf(id);
    } else {
      if (i === t.messageCount() - 1) return false;
      r -= t.rowCountOf(id);
      i++;
      id = t.messageIdAt(i);
    }
  }

  const goal = s.goal == null ? measure(t.rowTextAt(cursor.id, cursor.row).slice(0, cursor.col)) : s.goal;
  const body = t.rowTextAt(id, r);
  const row = /** @type {WrapRow} */ ({ start: 0, end: body.length });
  s.cursor = { id, row: r, col: caretAtCol(body, row, goal) };
  s.goal = goal;
  return true;
}

/** @param {Transcript} t @param {VimState} s @param {-1 | 0 | 1} motion @param {number} edge @param {boolean} [big] @returns {boolean} */
function wordStep(t, s, motion, edge, big = false) {
  const cursor = /** @type {Position} */ (s.cursor);
  const body = t.rowTextAt(cursor.id, cursor.row);
  const col = big ? wordBigMotion(body, cursor.col, motion) : wordMotion(body, cursor.col, motion);
  if (col !== cursor.col) {
    s.cursor = { ...cursor, col };
    return true;
  }
  if (!stepRow(t, s, edge)) return false;
  const next = /** @type {Position} */ (s.cursor);
  s.cursor = { ...next, col: edge > 0 ? 0 : t.rowTextAt(next.id, next.row).length };
  return true;
}

/** @param {Transcript} t @param {VimState} s @param {number} d @returns {boolean} */
function blockStep(t, s, d) {
  const cursor = /** @type {Position} */ (s.cursor);
  let i = t.messageIndex(cursor.id);
  if (i < 0) return false;

  let id = cursor.id;
  let blocks = t.blocksOf(id);
  let here = t.sourceAt(cursor);
  for (let r = cursor.row - 1; here < 0 && r >= 0; r--) here = t.sourceAt({ ...cursor, row: r });
  let k = -1;
  for (let n = 0; n < blocks.length; n++) {
    const block = /** @type {Block} */ (blocks[n]);
    if (here >= block.at) k = n;
  }
  k += d;

  while (k < 0 || k >= blocks.length) {
    i += d;
    if (i < 0 || i >= t.messageCount()) return false;
    id = t.messageIdAt(i);
    blocks = t.blocksOf(id);
    k = d > 0 ? 0 : blocks.length - 1;
  }

  const block = /** @type {Block} */ (blocks[k]);
  const pos = t.posAtSource(id, block.at);
  if (!pos) return false;
  s.cursor = pos;
  return true;
}

/** @param {Transcript} t @param {VimState} s @param {boolean} last @returns {boolean} */
function toEnd(t, s, last) {
  const total = t.messageCount();
  if (total === 0) return false;
  const id = t.messageIdAt(last ? total - 1 : 0);
  const count = t.rowCountOf(id);
  if (count === 0) return false;
  let r = last ? count - 1 : 0;
  while (last && r > 0 && t.rowTextAt(id, r) === "") r--;
  s.cursor = { id, row: r, col: 0 };
  return true;
}

/** @param {Transcript} t @param {VimState} s @param {string} k @returns {boolean} */
function move(t, s, k) {
  if (!s.cursor) return false;
  switch (k) {
    case "h":
    case "left":
      return stepCol(t, s, -1);
    case "l":
    case "right":
      return stepCol(t, s, 1);
    case "j":
    case "down":
      return stepRow(t, s, 1);
    case "k":
    case "up":
      return stepRow(t, s, -1);
    case "0":
    case "home":
      s.cursor = { ...s.cursor, col: 0 };
      return true;
    case "$":
    case "end":
      s.cursor = { ...s.cursor, col: t.rowTextAt(s.cursor.id, s.cursor.row).length };
      return true;
    case "G":
      return toEnd(t, s, true);
    case "W": return wordStep(t, s, 0, 1, true);
    case "B": return wordStep(t, s, -1, -1, true);
    case "E": return wordStep(t, s, 1, 1, true);
    case "w":
      return wordStep(t, s, 0, 1);
    case "b":
      return wordStep(t, s, -1, -1);
    case "e":
      return wordStep(t, s, 1, 1);
    case "}":
      return blockStep(t, s, 1);
    case "{":
      return blockStep(t, s, -1);
    case "J":
    case "K": {
      const pos = t.partStep(s.cursor, k === "J" ? 1 : -1);
      if (!pos) return false;
      s.cursor = pos;
      return true;
    }
  }
  return false;
}

/** @param {Transcript} t @param {VimState} s @returns {void} */
function expandLines(t, s) {
  if (!s.cursor || !s.anchor) return;
  const after = t.comparePos(s.cursor, s.anchor) >= 0;
  const lo = after ? s.anchor : s.cursor;
  const hi = after ? s.cursor : s.anchor;
  t.select({ ...lo, col: 0 }, { ...hi, col: t.rowTextAt(hi.id, hi.row).length });
}

/** @param {Transcript} t @param {VimState} s @returns {void} */
function syncSelection(t, s) {
  if (!s.visual || !s.cursor || !s.anchor) return;
  if (s.visualLines) expandLines(t, s);
  else t.select(s.anchor, s.cursor, { inclusive: true });
}

// A motion holds the column, syncs a visual selection, and scrolls the cursor into view.
/** @param {ChatView} view @param {VimState} s @param {Transcript} t @returns {boolean} */
function settle(view, s, t) {
  holdCol(t, s);
  syncSelection(t, s);
  t.ensureVisible(/** @type {Position} */ (s.cursor));
  return place(view, s);
}


/**
 * Vim keys for the composer and transcript. No TUI means no registrations.
 * Host allocation failures and invalid registrations throw. The context owns every registration and each mode.
 * @param {import("yuke").Context} ctx
 */
export default function (ctx) {
  const tui = ctx.get("tui");
  if (!tui) return;
  rootBorrow = tui.root;
  const editor = new ComposerEditor(ctx, tui, register);
  // Only dispatch uses the shared registry. All registrations use the owned facade.
  const shared = /** @type {typeof tui.keymap} */ (Object.getPrototypeOf(tui.keymap));
  const focused = () => focusedChat()?.composer || null;
  tui.command.add("normal", { run: () => { const c = focused(); if (c) editor.setMode(c, "normal"); } });
  tui.command.add("insert", { run: () => { const c = focused(); if (c) editor.setMode(c, "insert"); } });
  tui.context.add({ vim_mode: () => { const c = focused(), s = c ? editor.states.get(c) : null; return s ? s.mode : "insert"; } });
  tui.route.add("keymap", "composer && vim_mode != insert && !overlay");
  const reader = new TranscriptEditor(ctx, tui, { stateBorrow: stateOf, reanchorBorrow: reanchor, seedBorrow: seed, moveBorrow: move, settleBorrow: settle, placeBorrow: place }, register);
  ctx.effect(() => {
    const onKeyBorrow = shared.onKey;
    /** @param {Parameters<typeof shared.onKey>[0]} ev */
    const dispatchOwn = (ev) => {
    const view = focusedChat();
    if (!view || rootBorrow.focused !== view || ev.event === "release") return onKeyBorrow.call(shared, ev);
    if (shared.pending) return onKeyBorrow.call(shared, ev);
    if (view.focus === "composer") return editor.onKey(view.composer, ev) || onKeyBorrow.call(shared, ev);
    const stroke = keys.strokeOf(ev);
    if ((reader.pending || !BASIC_KEYS.has(stroke)) && reader.onKey(view, stroke, ev)) return true;
    return onKeyBorrow.call(shared, ev);
    };
    shared.onKey = dispatchOwn;
    return () => { if (shared.onKey === dispatchOwn) shared.onKey = onKeyBorrow; };
  });
  ctx.on("composer.prompt", c => editor.mode(c) !== "insert" ? "▪ " : null);
  tui.status.add({ side: "left", order: 0, render: () => {
    const view = focusedChat(); if (!view) return "";
    if (view.focus === "transcript") return panes.get(view)?.visual ? panes.get(view)?.visualLines ? "VISUAL LINE" : "VISUAL" : "NORMAL";
    const s = editor.states.get(view.composer);
    if (!s) return "INSERT";
    const label = s.mode === "normal" ? "NORMAL" : s.mode === "insert" ? "INSERT" : s.mode === "visual" ? "VISUAL" : "VISUAL LINE";
    return s.phase !== "ready" || s.count ? label + " " + s.operator + s.prefix + (s.count || "") : label;
  } });
  ctx.on("ui.started", () => { const c = focused(); if (c) editor.state(c); });
  ctx.on("pane.focused", view => { if (view instanceof ChatView) editor.state(view.composer); editor.visited.forEach(c => editor.cancel(c)); reader.cancel(); shared.pending = null; });
  ctx.on("region.focused", view => { editor.cancel(view.composer); reader.cancel(); shared.pending = null; });
  ctx.on("mouse.received", () => { const c = focused(); if (c) editor.cancel(c); reader.cancel(); });
  ctx.on("paste.received", () => { const c = focused(); if (c) { const s = editor.states.get(c); if (s) editor.reset(s); } reader.cancel(); });
  tui.command.add("vim-mode:focus-toggle", {
    run: () => {
      const view = focusedChat();
      if (!view) return;
      view.focusRegion(view.focus === "transcript" ? "composer" : "transcript");
      rootBorrow.invalidate();
    },
  });
  tui.keymap.add({ tab: "vim-mode:focus-toggle" }, "chat");

  // Normal keys reach the keymap only where the transcript holds the region focus.
  tui.route.add("keymap", TRANSCRIPT);

  // Visual mode is plugin state, so it rides a flag rather than an atom.
  tui.context.add({
    vim_visual: () => {
      const v = focusedChat();
      const s = v ? panes.get(v) : undefined;
      return s && s.visual ? "on" : "";
    },
  });

  // A region change ends visual mode, so a return to the transcript starts clean.
  ctx.on("region.focused", (view, region) => {
    let s = panes.get(view);
    if (region === "transcript" && !s) s = stateOf(view);
    // Only a focused transcript holds the caret, so a rebuild under the composer follows the tail again.
    view.transcript.caret = region === "transcript" && s ? s.cursor : null;
    if (!s) return;
    s.visual = false;
    s.visualLines = false;
    s.anchor = null;
    if (region !== "transcript") view.transcript.clearSelection();
  });

  /** @param {(view: ChatView, s: VimState, t: Transcript) => boolean} fn @returns {() => boolean} */
  const act = (fn) => () => {
    // The binding context already limits this to a focused transcript in the active pane.
    const view = focusedChat();
    if (!view) return false;
    const s = stateOf(view);
    const t = view.transcript;
    reanchor(t, s);
    if (!s.cursor) seed(view, s);
    if (!s.cursor) return false;
    return fn(view, s, t);
  };

  /** @type {Record<string, () => boolean>} */
  const motions = {};
  for (let i = 0; i < MOTION_KEYS.length; i++) {
    const k = /** @type {string} */ (MOTION_KEYS[i]);
    motions[k] = act((view, s, t) => {
      // Only a vertical motion keeps the goal column.
      if (k !== "j" && k !== "k" && k !== "up" && k !== "down") s.goal = null;
      if (!move(t, s, k)) return false;
      return settle(view, s, t);
    });
  }
  tui.keymap.add(motions, TRANSCRIPT);

  tui.keymap.add(
    {
      "/": () => { const view = focusedChat(); if (!view) return false; view.focusRegion("composer"); editor.setMode(view.composer, "insert"); view.composer.input.insert("/"); return true; },
      enter: act((view, s, t) => {
        s.cursor = t.activate(/** @type {Position} */ (s.cursor)) ?? s.cursor;
        return place(view, s);
      }),
      esc: act((view, s, t) => {
        reader.rememberVisual(view, s, t);
        s.visual = false;
        s.visualLines = false;
        s.anchor = null;
        t.clearSelection();
        return place(view, s);
      }),
      v: act((view, s, t) => {
        if (s.visualLines) { s.visualLines = false; syncSelection(t, s); return place(view, s); }
        if (s.visual) reader.rememberVisual(view, s, t);
        s.visual = !s.visual;
        s.anchor = s.visual ? s.cursor : null;
        if (s.visual) syncSelection(t, s);
        else t.clearSelection();
        return place(view, s);
      }),
    },
    TRANSCRIPT,
  );

  // `o` swaps the ends of an active selection.
  tui.keymap.add(
    {
      o: act((view, s, t) => {
        const swap = s.anchor;
        s.anchor = s.cursor;
        s.cursor = swap;
        syncSelection(t, s);
        t.ensureVisible(/** @type {Position} */ (s.cursor));
        return place(view, s);
      }),
    },
    VISUAL,
  );

  // The transcript supplies the caret only while it holds the region.
  ctx.on("chat.cursor", (view) => {
    if (view.focus !== "transcript") return null;
    const s = stateOf(view);
    if (!s.cursor) seed(view, s);
    if (!s.cursor) return null;
    const t = view.transcript;
    // Moved text takes the view along, and a scroll takes the cursor along. Either change shows on the next frame.
    if (reanchor(t, s)) {
      if (!s.cursor) seed(view, s);
      if (!s.cursor) return null;
      t.ensureVisible(/** @type {Position} */ (s.cursor));
      syncSelection(t, s);
      rootBorrow.invalidatePaint();
    }
    const at = t.screenAt(s.cursor);
    if (at) return { x: at.x, y: at.y, visible: true };
    if (keepOnScreen(t, s)) rootBorrow.invalidatePaint();
    return cursorOf(t, s.cursor);
  });

  // A click is the plugin's own way into the region, so it moves the focus itself.
  ctx.on("chat.press", (view, ev) => {
    const s = stateOf(view);
    const pos = view.transcript.posAt(ev.col, ev.row, false);
    if (!pos) {
      view.focusRegion("composer");
      return false;
    }
    view.focusRegion("transcript");
    s.cursor = pos;
    s.goal = null;
    s.visual = false;
    s.visualLines = false;
    s.anchor = null;
    return place(view, s);
  });

  ctx.on("pane.closed", (view) => {
    if (view instanceof ChatView) { editor.close(view.composer); panes.delete(view); visited.delete(view); }
  });
  ctx.own(() => {
    visited.forEach((view) => {
      view.transcript.caret = null;
      view.transcript.clearSelection();
      view.focusRegion("composer");
      panes.delete(view);
    });
    visited.clear();
    register.clear();
    rootBorrow.invalidate();
  });
  ctx.own(() => editor.dispose());
  ctx.own(() => reader.dispose());
}
