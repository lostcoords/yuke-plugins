//! Read-only transcript commands share Vim navigation with composer editing.
import { copy } from "yuke:ui";
import { Navigation, snap, clamp } from "./text.js";
/** @typedef {import("yuke:chat").ChatView} View */
/** @typedef {View["transcript"]} Transcript */
/** @typedef {import("./index.js").VimState} State */
/** @typedef {import("./index.js").Position} Position */
/** @typedef {NonNullable<ReturnType<Transcript["_anchors"]>>["a"]} SourceAnchor */
/** @typedef {{ kind: "source", source: SourceAnchor } | { kind: "header" | "group", id: number, partId: number, ordinal: number, col: number }} Anchor */
/** @typedef {{ stateBorrow: (view: View) => State, reanchorBorrow: (t: Transcript, s: State) => boolean, seedBorrow: (view: View, s: State) => void, moveBorrow: (t: Transcript, s: State, key: string) => boolean, settleBorrow: (view: View, s: State, t: Transcript) => boolean, placeBorrow: (view: View, s: State) => boolean }} Hooks */
const REGISTER = /^[a-zA-Z0-9"_\-]$/;
const LETTER = /^[a-z]$/;
const MOTIONS = new Set("h l j k left right up down 0 home $ end w b e W B E { } J K".split(" "));
const REVERSE = /** @type {Record<string, string>} */ ({ f: "F", F: "f", t: "T", T: "t" });
class ReadState {
  constructor() {
    this.nav = new Navigation();
    this.find = ""; this.glyph = "";
    this.query = ""; this.forward = true; this.whole = false;
    /** @type {{ a: Anchor, b: Anchor, lines: boolean } | null} */ this.visualOwn = null;
    /** @type {ReturnType<Transcript["_rows"]["get"]>} */ this.cacheBorrow = undefined;
    this.docId = -1; this.docTextOwn = "";
    /** @type {number[]} */ this.startsOwn = [];
    /** @type {string[]} */ this.partsOwn = [];
  }
}
/** A plugin-owned read-only FSM. It borrows the TUI, registers, and transcript hooks. Marks last for this plugin run. Host failures throw. */
export class TranscriptEditor {
  /** @param {import("yuke").Context} ctx @param {import("yuke:ui").Tui} tui @param {Hooks} hooksBorrow @param {import("./registers.js").Registers} registersBorrow */
  constructor(ctx, tui, hooksBorrow, registersBorrow) {
    this.ctx = ctx; this.tui = tui; this.hooksBorrow = hooksBorrow; this.registersBorrow = registersBorrow;
    this.pending = false; this.phase = "ready"; this.prefix = ""; this.operator = "";
    this.count = 0; this.leading = 0; this.register = '"';
    /** @type {WeakMap<Transcript, ReadState>} */ this.states = new WeakMap();
    /** @type {Map<string, Map<string, Anchor>>} */ this.marksOwn = new Map();
    /** @type {WeakMap<View["session"], Map<string, Anchor>>} */ this.draftMarksOwn = new WeakMap();
  }
  /** Cancel only the pending command. Saved marks and searches remain. */
  cancel() { this.pending = false; this.phase = "ready"; this.prefix = ""; this.operator = ""; this.count = 0; this.leading = 0; this.register = '"'; }
  /** Release all owned mark and navigation state. */
  dispose() { this.cancel(); this.marksOwn.clear(); this.draftMarksOwn = new WeakMap(); this.states = new WeakMap(); }
  /** @param {Transcript} t */
  state(t) { let r = this.states.get(t); if (!r) { r = new ReadState(); this.states.set(t, r); } return r; }
  /** @param {View} view @param {boolean} create */
  marks(view, create) {
    const id = view.session.sessionId;
    let marks = id ? this.marksOwn.get(id) : this.draftMarksOwn.get(view.session);
    if (!marks && create) { marks = new Map(); if (id) this.marksOwn.set(id, marks); else this.draftMarksOwn.set(view.session, marks); }
    return marks;
  }
  /** @param {Transcript} t @param {Position} pos @returns {Anchor | null} */
  capture(t, pos) {
    const rowsBorrow = t._rowsFor(pos.id), rowBorrow = rowsBorrow[pos.row];
    if (!rowBorrow) return null;
    if (rowBorrow.partId != null && (rowBorrow.header || rowBorrow.stop && t.sourceAt(pos) < 0)) return { kind: "header", id: pos.id, partId: rowBorrow.partId, ordinal: 0, col: pos.col };
    if (rowBorrow.partId == null && t.rowTextAt(pos.id, pos.row) !== "") {
      for (let row = pos.row + 1; row < rowsBorrow.length; row++) {
        const partId = rowsBorrow[row].partId; if (partId == null) continue;
        const lead = t._parts.get(String(pos.id))?.rows.get(String(partId))?.lead || 0;
        const ordinal = pos.row - (row - lead);
        if (ordinal >= 0 && ordinal < lead) return { kind: "group", id: pos.id, partId, ordinal, col: pos.col };
        break;
      }
    }
    const selectionBorrow = t.selection;
    t.selection = { anchor: pos, cursor: pos };
    try { const source = t._anchors()?.a; return source ? { kind: "source", source } : null; } finally { t.selection = selectionBorrow; }
  }
  /** @param {Transcript} t @param {Anchor} anchor @returns {Position | null} */
  resolve(t, anchor) {
    if (anchor.kind !== "source") {
      if (t.messageIndex(anchor.id) < 0) return null;
      const rowsBorrow = t._rowsFor(anchor.id);
      for (let row = 0; row < rowsBorrow.length; row++) {
        const itemBorrow = rowsBorrow[row]; if (itemBorrow.partId !== anchor.partId) continue;
        if (anchor.kind === "header") { if (!itemBorrow.header && !itemBorrow.stop) continue; }
        else {
          const lead = t._parts.get(String(anchor.id))?.rows.get(String(anchor.partId))?.lead || 0;
          if (anchor.ordinal >= lead) return null;
          row = row - lead + anchor.ordinal;
          if (row < 0 || rowsBorrow[row].partId != null) return null;
        }
        const textBorrow = t.rowTextAt(anchor.id, row);
        return { id: anchor.id, row, col: clamp(textBorrow, snap(textBorrow, Math.min(anchor.col, textBorrow.length))) };
      }
      return null;
    }
    const source = anchor.source;
    if (t.messageIndex(source.id) < 0) return null;
    const pos = t._posAtAnchor(source); if (!pos) return null;
    const base = source.partId == null ? 0 : t._rows.get(String(source.id))?.partBases.get(source.partId);
    return base != null && t.sourceAt(pos) === base + source.off ? pos : null;
  }
  /** @param {View} view @param {State} s @param {Transcript} t */
  rememberVisual(view, s, t) {
    if (!s.visual || !s.anchor || !s.cursor) return;
    const a = this.capture(t, s.anchor), b = this.capture(t, s.cursor);
    if (a && b) this.state(t).visualOwn = { a, b, lines: s.visualLines };
  }
  /** @param {Transcript} t @param {ReadState} r @param {number} id */
  document(t, r, id) {
    t._rowsFor(id);
    const cacheBorrow = t._rows.get(String(id));
    if (r.docId === id && r.cacheBorrow === cacheBorrow) return r.docTextOwn;
    r.docId = id; r.cacheBorrow = cacheBorrow; r.startsOwn.length = 0; r.partsOwn.length = 0;
    let offset = 0;
    let rows = t.rowCountOf(id);
    while (rows && cacheBorrow?.rows[rows - 1]?.partId == null && t.rowTextAt(id, rows - 1) === "") rows--;
    for (let row = 0; row < rows; row++) { const text = t.rowTextAt(id, row); r.startsOwn.push(offset); r.partsOwn.push(text); offset += text.length + 1; }
    r.docTextOwn = r.partsOwn.join("\n"); r.nav.clear(); return r.docTextOwn;
  }
  /** @param {ReadState} r @param {number} offset @returns {Position} */
  position(r, offset) {
    let lo = 0, hi = r.startsOwn.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >>> 1; if (r.startsOwn[mid] <= offset) lo = mid + 1; else hi = mid - 1; }
    const row = Math.max(0, hi);
    return { id: r.docId, row, col: Math.min(r.partsOwn[row]?.length || 0, Math.max(0, offset - r.startsOwn[row])) };
  }
  /** @param {View} view @param {State} s @param {Transcript} t */
  prepare(view, s, t) { this.hooksBorrow.reanchorBorrow(t, s); if (!s.cursor) this.hooksBorrow.seedBorrow(view, s); return s.cursor; }
  /** @param {View} view @param {string} stroke @param {Parameters<import("yuke:ui").Tui["keymap"]["onKey"]>[0]} ev */
  onKey(view, stroke, ev) {
    if (stroke === "esc" || stroke === "ctrl+[") {
      this.cancel();
      if (stroke === "ctrl+[") { const s = this.hooksBorrow.stateBorrow(view), t = view.transcript; this.rememberVisual(view, s, t); s.visual = false; s.visualLines = false; s.anchor = null; t.clearSelection(); this.hooksBorrow.placeBorrow(view, s); return true; }
      return false;
    }
    if ((ev.mods & 14) !== 0 && stroke !== "alt+/") { this.cancel(); return false; }
    if (stroke === "tab" || stroke === "/" || stroke === "enter") { this.cancel(); return false; }
    const s = this.hooksBorrow.stateBorrow(view), t = view.transcript;
    const counted = !!(this.leading || this.count), count = (this.leading || 1) * (this.count || 1);
    if (this.phase === "register") { this.phase = "ready"; if (REGISTER.test(stroke)) this.register = stroke; else this.cancel(); return true; }
    if (this.phase === "mark") {
      if (LETTER.test(stroke)) this.mark(view, s, t, stroke, this.prefix);
      this.cancel(); return true;
    }
    if (this.phase === "character") {
      const r = this.state(t);
      if (stroke && r.nav.next(stroke, 0) === stroke.length) this.execute(view, s, t, this.prefix, count, stroke, counted);
      this.cancel(); return true;
    }
    if (this.phase === "object") { this.execute(view, s, t, this.prefix + stroke, count, "", counted); this.cancel(); return true; }
    if (this.phase === "prefix") {
      const prefix = this.prefix; this.phase = "ready";
      if (prefix === "g" && stroke === "v" && !this.operator) {
        const saved = this.states.get(t)?.visualOwn;
        const a = saved && this.resolve(t, saved.a), b = saved && this.resolve(t, saved.b);
        if (a && b && saved) { s.anchor = a; s.cursor = b; s.visual = true; s.visualLines = saved.lines; this.hooksBorrow.settleBorrow(view, s, t); }
      } else if (prefix === "g" && stroke === "y" && !this.operator) {
        if (this.prepare(view, s, t)) { this.rememberVisual(view, s, t); this.copySelection(t, s, true, s.visualLines || !s.visual); this.hooksBorrow.placeBorrow(view, s); }
      } else this.execute(view, s, t, prefix + stroke, count, "", counted);
      this.cancel(); return true;
    }
    if (stroke.length === 1 && stroke >= "0" && stroke <= "9" && (stroke !== "0" || this.count)) {
      this.count = this.count * 10 + Number(stroke); this.pending = true;
      if ((this.leading || 1) * this.count > 10000) { this.cancel(); this.ctx.interaction.notify("Vim count exceeds 10000", "warn"); }
      return true;
    }
    if (stroke === '"') { this.pending = true; this.phase = "register"; return true; }
    if (stroke === "m" && !this.operator || stroke === "'" || stroke === "`") { this.pending = true; this.phase = "mark"; this.prefix = stroke; return true; }
    if ("fFtT".includes(stroke) && stroke.length === 1) { this.pending = true; this.phase = "character"; this.prefix = stroke; return true; }
    if (stroke === "g") { this.pending = true; this.phase = "prefix"; this.prefix = "g"; return true; }
    if ((stroke === "i" || stroke === "a") && (this.operator || s.visual)) { this.pending = true; this.phase = "object"; this.prefix = stroke; return true; }
    if (stroke === "y" && !this.operator) {
      if (s.visual) { this.rememberVisual(view, s, t); this.copySelection(t, s, false, s.visualLines); this.hooksBorrow.placeBorrow(view, s); this.cancel(); }
      else { this.operator = "y"; this.leading = counted ? count : 0; this.count = 0; this.pending = true; }
      return true;
    }
    if (stroke === "V") {
      if (this.prepare(view, s, t)) {
        if (s.visual && s.visualLines) { this.rememberVisual(view, s, t); s.visual = false; s.visualLines = false; s.anchor = null; t.clearSelection(); }
        else { if (!s.visual) s.anchor = s.cursor; s.visual = true; s.visualLines = true; }
        this.hooksBorrow.settleBorrow(view, s, t);
      }
      this.cancel(); return true;
    }
    if (stroke === "?" || stroke === "alt+/") { this.openSearch(view, s, t, stroke !== "?"); this.cancel(); return true; }
    const handled = this.execute(view, s, t, stroke, count, "", counted);
    const consumed = this.pending || handled;
    this.cancel(); return consumed;
  }
  /** @param {View} view @param {State} s @param {Transcript} t @param {string} name @param {string} kind */
  mark(view, s, t, name, kind) {
    if (kind === "m") {
      const pos = this.prepare(view, s, t), own = pos && this.capture(t, pos);
      if (own) this.marks(view, true)?.set(name, own);
      else this.ctx.interaction.notify("No markable text under the transcript cursor", "warn");
      return;
    }
    const own = this.marks(view, false)?.get(name), target = own && this.resolve(t, own);
    if (!target) { this.ctx.interaction.notify("Transcript mark " + name + " is unset, hidden, or no longer available", "warn"); return; }
    if (kind === "'") { const text = t.rowTextAt(target.id, target.row); target.col = 0; while (target.col < text.length && (text[target.col] === " " || text[target.col] === "\t")) target.col++; }
    if (this.operator) this.range(view, s, t, target, false, kind === "'");
    else { s.cursor = target; s.goal = null; this.hooksBorrow.settleBorrow(view, s, t); }
  }
  /** @param {View} view @param {State} s @param {Transcript} t @param {Position} target @param {boolean} inclusive @param {boolean} lines */
  range(view, s, t, target, inclusive, lines) {
    const origin = s.cursor; if (!origin) return;
    const before = t.comparePos(origin, target) <= 0;
    let from = before ? origin : target, to = before ? target : origin;
    if (lines) { from = { ...from, col: 0 }; to = { ...to, col: t.rowTextAt(to.id, to.row).length }; }
    else if (inclusive) { const body = t.rowTextAt(to.id, to.row); to = { ...to, col: this.state(t).nav.next(body, to.col) }; }
    t.select(from, to);
    s.cursor = from;
    this.copySelection(t, s, false, lines); s.goal = null;
    this.hooksBorrow.settleBorrow(view, s, t);
  }
  /** @param {Transcript} t @param {State} s @param {boolean} source @param {boolean} lines */
  copySelection(t, s, source, lines) {
    if (!t.selection && s.cursor) t.select({ ...s.cursor, col: 0 }, { ...s.cursor, col: t.rowTextAt(s.cursor.id, s.cursor.row).length });
    const selectionBorrow = t.selection;
    if (selectionBorrow) { s.cursor = t.comparePos(selectionBorrow.anchor, selectionBorrow.cursor) <= 0 ? selectionBorrow.anchor : selectionBorrow.cursor; if (lines) s.cursor = { ...s.cursor, col: 0 }; }
    const value = t.selectedText(source);
    this.registersBorrow.save(value, lines, "y", this.register);
    if (this.register !== "_") copy(value, source ? "source" : "selection");
    t.clearSelection(); s.visual = false; s.visualLines = false; s.anchor = null;
  }
  /** @param {View} view @param {State} s @param {Transcript} t @param {string} motion @param {number} count @param {string} glyph @param {boolean} counted */
  execute(view, s, t, motion, count, glyph, counted) {
    const origin = this.prepare(view, s, t); if (!origin) return true;
    let target = /** @type {Position | null} */ (null), inclusive = false, lines = false;
    if (motion === "y" && this.operator || motion === "Y") {
      for (let n = 1; n < count; n++) this.hooksBorrow.moveBorrow(t, s, "j");
      target = s.cursor; s.cursor = origin; this.range(view, s, t, /** @type {Position} */ (target), false, true); return true;
    }
    if (motion === "gg" || motion === "G" || motion === "%" && counted) {
      let wanted = count;
      if (motion === "%") { if (count > 100) return true; wanted = Math.ceil(this.totalRows(t) * count / 100); }
      else if (motion === "G" && !counted) { this.hooksBorrow.moveBorrow(t, s, "G"); target = s.cursor; s.cursor = origin; }
      if (!target) target = this.rowAt(t, wanted - 1); lines = true;
    } else if (motion === "n" || motion === "N" || motion === "*" || motion === "#" || motion === "g*" || motion === "g#") {
      const r = this.state(t);
      if (motion.includes("*") || motion.includes("#")) {
        const text = t.rowTextAt(origin.id, origin.row); let at = origin.col;
        while (at < text.length && r.nav.cls(text, at) < 2) at = r.nav.next(text, at);
        const word = at < text.length && r.nav.wordObject(text, at, false, 1, false);
        if (!word) return true;
        r.query = text.slice(word.from, word.to); r.forward = motion.includes("*"); r.whole = motion.length === 1;
      }
      target = this.search(t, r, origin, motion === "N" ? !r.forward : r.forward, count);
    } else if (motion === "%" || motion === "ge" || motion === "gE" || motion === "{" || motion === "}" || motion.length === 2 && (motion[0] === "i" || motion[0] === "a")) {
      const r = this.state(t), text = this.document(t, r, origin.id), at = (r.startsOwn[origin.row] == null ? text.length : r.startsOwn[origin.row] + origin.col);
      if (motion[0] === "i" || motion[0] === "a") {
        const object = r.nav.object(text, at, motion[1], motion[0] === "a", count); if (!object) return true;
        const from = this.position(r, object.from), to = this.position(r, object.to);
        if (this.operator) { s.cursor = from; this.range(view, s, t, to, false, false); }
        else if (s.visual) { s.anchor = from; s.cursor = this.position(r, r.nav.prev(text, object.to)); s.visualLines = false; this.hooksBorrow.settleBorrow(view, s, t); }
        return true;
      }
      let offset = motion === "%" ? r.nav.match(text, at) : motion === "{" || motion === "}" ? r.nav.paragraph(text, at, motion === "}", count) : r.nav.previousEnd(text, at, count, motion === "gE");
      if (offset < 0 && (motion === "ge" || motion === "gE")) {
        for (let i = t.messageIndex(origin.id) - 1; i >= 0 && offset < 0; i--) { const previous = this.document(t, r, t.messageIdAt(i)); offset = r.nav.previousEnd(previous, previous.length, 1, motion === "gE"); }
      }
      if (offset >= 0) target = this.position(r, offset);
      inclusive = motion === "%" || motion === "ge" || motion === "gE";
    } else if ("fFtT".includes(motion) && motion.length === 1 || motion === ";" || motion === ",") {
      const r = this.state(t), repeat = motion === ";" || motion === ",", kind = repeat ? motion === ";" ? r.find : REVERSE[r.find] : motion;
      if (!kind) return true;
      if (!repeat) { r.find = kind; r.glyph = glyph; }
      const text = t.rowTextAt(origin.id, origin.row), offset = r.nav.find(text, origin.col, kind, repeat ? r.glyph : glyph, count, repeat);
      if (offset >= 0) target = { ...origin, col: offset };
      inclusive = kind === "f" || kind === "t";
    } else if (motion === "^") {
      const text = t.rowTextAt(origin.id, origin.row); let col = 0; while (col < text.length && (text[col] === " " || text[col] === "\t")) col++;
      target = { ...origin, col };
    } else {
      const key = motion === "gj" ? "j" : motion === "gk" ? "k" : motion;
      if (!MOTIONS.has(key)) return false;
      if (key === "$" || key === "end") { for (let n = 1; n < count; n++) if (!this.hooksBorrow.moveBorrow(t, s, "j")) break; this.hooksBorrow.moveBorrow(t, s, key); }
      else for (let n = 0; n < count; n++) if (!this.hooksBorrow.moveBorrow(t, s, key)) break;
      target = s.cursor; s.cursor = origin;
      inclusive = key === "e" || key === "E" || key === "$" || key === "end";
      lines = key === "j" || key === "k" || key === "up" || key === "down";
    }
    if (target) {
      if (this.operator) this.range(view, s, t, target, inclusive, lines);
      else { s.cursor = target; if (!(motion === "j" || motion === "k" || motion === "gj" || motion === "gk")) s.goal = null; this.hooksBorrow.settleBorrow(view, s, t); }
    }
    return true;
  }
  /** @param {Transcript} t */
  totalRows(t) { let count = 0; for (let i = 0; i < t.messageCount(); i++) count += t.rowCountOf(t.messageIdAt(i)); return count; }
  /** @param {Transcript} t @param {number} wanted @returns {Position | null} */
  rowAt(t, wanted) {
    let tail = /** @type {Position | null} */ (null);
    for (let i = 0; i < t.messageCount(); i++) {
      const id = t.messageIdAt(i), rows = t.rowCountOf(id);
      if (!rows) continue;
      if (wanted < rows) return { id, row: Math.max(0, wanted), col: 0 };
      wanted -= rows; tail = { id, row: rows - 1, col: 0 };
    }
    return tail;
  }
  /** @param {Transcript} t @param {ReadState} r @param {Position} origin @param {boolean} forward @param {number} count @returns {Position | null} */
  search(t, r, origin, forward, count) {
    if (!r.query) return null;
    let pos = origin;
    for (let n = 0; n < count; n++) {
      let index = t.messageIndex(pos.id), found = false;
      const total = t.messageCount();
      for (let step = 0; step <= total && !found; step++) {
        const id = t.messageIdAt(index), text = this.document(t, r, id);
        const limit = step === 0 ? (r.startsOwn[pos.row] == null ? text.length : r.startsOwn[pos.row] + pos.col) : forward ? -1 : text.length;
        let at = forward ? text.indexOf(r.query, limit + 1) : limit > 0 ? text.lastIndexOf(r.query, limit - 1) : -1;
        while (at >= 0) {
          const end = at + r.query.length;
          if (snap(text, at) === at && snap(text, end) === end && (!r.whole || (at === 0 || r.nav.cls(text, r.nav.prev(text, at)) < 2) && (end === text.length || r.nav.cls(text, end) < 2))) { pos = this.position(r, at); found = true; break; }
          at = forward ? text.indexOf(r.query, at + 1) : at > 0 ? text.lastIndexOf(r.query, at - 1) : -1;
        }
        index = (index + (forward ? 1 : total - 1)) % total;
      }
      if (!found) return null;
    }
    return pos;
  }
  /** @param {View} view @param {State} s @param {Transcript} t @param {boolean} forward */
  openSearch(view, s, t, forward) {
    const origin = this.prepare(view, s, t); if (!origin) return;
    const r = this.state(t), sessionBorrow = view.session, sessionId = sessionBorrow.sessionId;
    const caretBorrow = s.cursor, selectionBorrow = t.selection, width = t._width;
    const operator = this.operator, register = this.register;
    this.document(t, r, origin.id); const cacheBorrow = r.cacheBorrow;
    this.ctx.interaction.input("Search transcript (literal, case-sensitive)", r.query).then(value => {
      if (!this.ctx.alive || value == null || this.tui.root.active !== view || this.tui.root.focused !== view || view.focus !== "transcript" || view.session !== sessionBorrow || sessionBorrow.sessionId !== sessionId || view.transcript !== t || s.cursor !== caretBorrow || t.selection !== selectionBorrow || t._width !== width) return;
      t._rowsFor(origin.id); if (t._rows.get(String(origin.id)) !== cacheBorrow) return;
      if (value) r.query = value; r.forward = forward; r.whole = false;
      const target = this.search(t, r, origin, forward, 1);
      if (target) { if (operator) { this.register = register; this.range(view, s, t, target, false, false); this.cancel(); } else { s.cursor = target; s.goal = null; this.hooksBorrow.settleBorrow(view, s, t); } }
    }).catch(error => { if (this.ctx.alive) this.ctx.interaction.notify(String(error), "warn"); });
  }
}
