//! One extended FSM owns composer editing, history, selection, and repeat.
import { copy, keys, measure, caretAtCol, text as paint } from "yuke:ui";
import { Navigation, lineStart, lineEnd, afterLine, firstNonblank, clamp, snap } from "./text.js";

/** @typedef {import("yuke:ui").Composer} Buffer */
/** @typedef {import("yuke:ui").Tui} Tui */
/** @typedef {import("./text.js").Range} Range */
/** @typedef {ReturnType<Buffer["snapshot"]>["spans"]} Spans */
/** @typedef {{ text: string, caret: number, spans: Spans, marks: Map<string, number> | null }} Snapshot */
/** @typedef {{ kind: string, motion: string, operator: string, count: number, glyph: string, register: string, width: number, lines: boolean, edits: (number | string)[] }} Recipe */
/** @typedef {{ row: number, offset: number, value: string }} Segment */
const MAX_COUNT = 10000;
const HISTORY_GROUPS = 100;
const HISTORY_CHARS = 1024 * 1024;
const EMPTY_SPANS = /** @type {Spans} */ ([]);
const MODIFIED = /^(ctrl|alt|super)\+/;
const REGISTER_NAME = /^[a-zA-Z0-9"_\-]$/;
const MARK_NAME = /^[a-z]$/;
const INSERT_KEYS = new Set(["i", "a", "I", "A", "o", "O"]);
const SIMPLE_KEYS = new Set(["x", "X", "s", "S", "D", "C", "Y", "~", "J"]);
const VERTICAL = new Set(["j", "k", "up", "down", "gj", "gk"]);
const NAMED_MOTIONS = new Set(["left", "right", "up", "down", "home", "end"]);
const REVERSE_FIND = /** @type {Record<string, string>} */ ({ f: "F", F: "f", t: "T", T: "t" });

class BufferState {
  constructor() {
    this.mode = "insert";
    this.phase = "ready";
    this.prefix = "";
    this.operator = "";
    this.leading = 0;
    this.count = 0;
    this.register = '"';
    this.anchor = 0;
    this.visualFrom = 0;
    this.visualTo = 0;
    this.visualLines = false;
    this.haveVisual = false;
    this.findKind = "";
    this.findGlyph = "";
    /** @type {Map<string, number> | null} */ this.marks = null;
    this.query = "";
    this.searchForward = true;
    this.searchWhole = false;
    /** @type {Snapshot[]} */ this.undo = [];
    /** @type {Snapshot[]} */ this.redo = [];
    /** @type {Snapshot | null} */ this.base = null;
    /** @type {Recipe | null} */ this.record = null;
    /** @type {Recipe | null} */ this.last = null;
    this.insertOrigin = 0;
    this.expectedCaret = 0;
    this.insertCount = 1;
    this.editFrom = -1;
    this.editOldTo = 0;
    this.editNewTo = 0;
    this.muted = false;
    this.setting = false;
    this.textBorrow = "";
    this.replaying = false;
    this.nav = new Navigation();
    this.range = { from: 0, to: 0, target: 0, lines: false, inclusive: false };
    /** @type {ReturnType<Buffer["_projection"]> | null} */ this.paintProjection = null;
    this.paintFrom = -1;
    this.paintTo = -1;
    this.paintWidth = -1;
    this.paintScroll = -1;
    this.paintHeight = -1;
    /** @type {Segment[]} */ this.segments = [];
    /** @type {(() => void) | null} */ this.drawOff = null;
    /** @type {(() => void) | null} */ this.releaseEdit = null;
    /** @type {(() => void) | null} */ this.releaseSet = null;
    /** @type {(() => void) | null} */ this.releaseKeys = null;
    /** @type {(() => void) | null} */ this.pendingRoute = null;
  }
}

/** A plugin-owned composer FSM. It borrows composers and the TUI. Invalid registrations and host allocation failures throw. */
export class ComposerEditor {
  /** @param {import("yuke").Context} ctx @param {Tui} tui @param {import("./registers.js").Registers} registers */
  constructor(ctx, tui, registers) {
    this.ctx = ctx;
    this.tui = tui;
    this.registers = registers;
    /** @type {WeakMap<Buffer, BufferState>} */ this.states = new WeakMap();
    /** @type {Set<Buffer>} */ this.visited = new Set();
    tui.style.set({ VimSelection: { reverse: true } }, { default: true });
    ctx.on("composer.attached", c => { const s = this.states.get(c); if (s && s.record) s.last = null; });
  }
  /** @param {Buffer} c @returns {BufferState} */
  state(c) {
    const old = this.states.get(c);
    if (old) return old;
    return this.bind(c);
  }
  /** @param {Buffer} c */
  bind(c) {
    const s = new BufferState();
    this.states.set(c, s);
    this.visited.add(c);
    s.textBorrow = c.input.text;
    s.releaseEdit = this.ctx.effect(() => {
      const onEditBorrow = c.input.onEdit;
      /** @param {number} from @param {number} to @param {number} length */
      const onEditOwn = (from, to, length) => {
        if (!s.muted && !s.setting) {
          if (s.mode === "insert" && s.base && s.record && !s.replaying && !s.marks && !s.record.edits.length && s.editFrom >= 0 && (from === s.expectedCaret || to === s.expectedCaret) && from >= s.editFrom && to <= s.editNewTo) s.editNewTo += length - (to - from);
          else this.recordEdit(c, s, from, to, length);
        }
        if (c.input.caret < c.input.text.length && (c.input.text.charCodeAt(c.input.caret) >= 256 || c.input.text.charCodeAt(c.input.caret - 1) === 13 && c.input.text.charCodeAt(c.input.caret) === 10)) c.input.caret = s.nav.after(c.input.text, c.input.caret);
        s.expectedCaret = c.input.caret; s.setting = false; s.textBorrow = c.input.text;
        if (onEditBorrow) onEditBorrow(from, to, length);
      };
      c.input.onEdit = onEditOwn;
      return () => { if (c.input.onEdit === onEditOwn) c.input.onEdit = onEditBorrow; };
    });
    s.releaseKeys = this.ctx.effect(() => {
      const onKeyBorrow = c.input.onKey;
      /** @param {Parameters<Buffer["input"]["onKey"]>[0]} ev */
      const onKeyOwn = (ev) => {
        if (ev.type === "key" && ev.code === "char" && (ev.mods & 14) === 0) { c.input.insert(ev.text || ev.char || ""); return true; }
        if (ev.type === "key" && ev.code === "backspace" && ev.mods === 0) {
          if (c.input.caret > 0) c.input.replace(s.nav.prev(c.input.text, c.input.caret), c.input.caret, "");
          return true;
        }
        if (ev.type === "key" && ev.mods === 4 && ev.char === "w" && s.mode === "insert") { this.deleteInsertWord(c); return true; }
        return onKeyBorrow.call(c.input, ev);
      };
      c.input.onKey = onKeyOwn;
      return () => { if (c.input.onKey === onKeyOwn) c.input.onKey = onKeyBorrow; };
    });
    s.releaseSet = this.ctx.effect(() => {
      const setTextBorrow = c.input.setText;
      /** @param {string} value */
      const setTextOwn = value => {
        if (!s.muted) {
          s.setting = true; s.base = null; s.record = null; s.last = null; s.editFrom = -1;
          s.undo.length = 0; s.redo.length = 0;
          s.marks = null; s.haveVisual = false;
          if (s.mode !== "normal" && s.mode !== "insert") s.mode = "normal";
          this.reset(s); s.nav.clear();
        }
        setTextBorrow.call(c.input, value);
      };
      c.input.setText = setTextOwn;
      return () => { if (c.input.setText === setTextOwn) c.input.setText = setTextBorrow; };
    });
    return s;
  }
  /** @param {Buffer} c @param {BufferState} s @param {number} from @param {number} to @param {number} length */
  recordEdit(c, s, from, to, length) {
    if (s.mode === "insert") {
      if (s.base && from !== s.expectedCaret && to !== s.expectedCaret) {
        this.finish(c, s, s.textBorrow);
      }
      if (!s.base) this.beginAfter(c, s, from);
      if (s.record && !s.replaying) {
        if (!s.record.edits.length && from >= s.editFrom && to <= s.editNewTo && s.editFrom >= 0) s.editNewTo += length - (to - from);
        else this.recordOutside(s.textBorrow, s, from, to, c.input.text.slice(from, from + length));
      }
    }
    if (s.marks) this.shiftMarks(s, s.textBorrow, from, to, c.input.text.slice(from, from + length));
  }
  /** @param {Buffer} c @param {BufferState} s @param {number} from */
  beginAfter(c, s, from) {
    this.begin(c, s, "insert", "i", "", 1);
    if (s.base) { s.base.text = s.textBorrow; s.base.caret = from; }
    s.insertOrigin = from;
  }
  /** @param {string} textBorrow @param {BufferState} s @param {number} from @param {number} to @param {string} value */
  recordOutside(textBorrow, s, from, to, value) {
    const recipe = s.record;
    if (!recipe) return;
    if (recipe.edits.length) { recipe.edits.push(from - s.insertOrigin, to - from, value); return; }
    if (s.editFrom < 0) { s.editFrom = from; s.editOldTo = to; s.editNewTo = from + value.length; return; }
    if (from > s.editNewTo || to < s.editFrom) {
      recipe.edits.push(s.editFrom - s.insertOrigin, s.editOldTo - s.editFrom, textBorrow.slice(s.editFrom, s.editNewTo), from - s.insertOrigin, to - from, value); return;
    }
    const delta = s.editNewTo - s.editOldTo;
    const originalFrom = from < s.editFrom ? from : from > s.editNewTo ? from - delta : s.editFrom;
    const originalTo = to < s.editFrom ? to : to > s.editNewTo ? to - delta : s.editOldTo;
    s.editFrom = Math.min(s.editFrom, originalFrom); s.editOldTo = Math.max(s.editOldTo, originalTo);
    s.editNewTo = s.editOldTo + delta + value.length - (to - from);
  }
  /** Delete one Vim word in Insert mode. It keeps the current line break until a separate stroke at line start. Host failures throw. @param {Buffer} c */
  deleteInsertWord(c) {
    const s = this.state(c), text = c.input.text, to = c.input.caret, start = lineStart(text, to);
    if (to === 0) return;
    let from = s.nav.prev(text, to);
    if (to > start) {
      while (from > start && s.nav.cls(text, from) === 0) from = s.nav.prev(text, from);
      const cls = s.nav.cls(text, from);
      while (from > start && s.nav.cls(text, s.nav.prev(text, from)) === cls) from = s.nav.prev(text, from);
    }
    c.input.replace(from, to, ""); this.reset(s);
  }
  /** @param {Buffer | null} c */
  mode(c) { return c ? this.states.get(c)?.mode || "insert" : ""; }
  /** @param {BufferState} s */
  reset(s) { if (s.pendingRoute) { s.pendingRoute(); s.pendingRoute = null; } if (!s.mode.startsWith("visual") && s.drawOff) { s.drawOff(); s.drawOff = null; } s.phase = "ready"; s.prefix = ""; s.operator = ""; s.leading = 0; s.count = 0; s.register = '"'; }
  /** @param {Buffer} c @param {string} next */
  setMode(c, next) {
    const s = this.state(c);
    if (s.mode === next) return;
    if (s.mode === "insert") this.finishInsert(c, s, false);
    if (s.mode.startsWith("visual")) this.rememberVisual(c, s);
    s.mode = next;
    this.reset(s);
    if (next === "normal") c.input.caret = clamp(c.input.text, snap(c.input.text, c.input.caret));
    this.tui.root.invalidate();
  }
  /** @param {Buffer} c */
  cancel(c) {
    const s = this.states.get(c);
    if (!s) return;
    if (s.mode.startsWith("visual")) { this.rememberVisual(c, s); s.mode = "normal"; }
    if (s.mode === "insert") this.finish(c, s);
    this.reset(s);
  }
  /** @param {Buffer} c */
  close(c) { this.cancel(c); const s = this.states.get(c); if (s) { if (s.drawOff) s.drawOff(); if (s.releaseEdit) s.releaseEdit(); if (s.releaseSet) s.releaseSet(); if (s.releaseKeys) s.releaseKeys(); s.undo.length = 0; s.redo.length = 0; s.base = null; s.last = null; s.nav.clear(); s.textBorrow = ""; } this.states.delete(c); this.visited.delete(c); }
  /** Drop references when the plugin unloads. No failure. */
  dispose() { this.visited.forEach(c => this.close(c)); }
  /** @param {Buffer} c @param {BufferState} s @returns {Snapshot} */
  snapshot(c, s) {
    return { text: c.input.text, caret: c.input.caret, spans: c.spans.length ? c.spans.map(span => ({ ...span })) : EMPTY_SPANS, marks: s.marks ? new Map(s.marks) : null };
  }
  /** @param {Snapshot[]} history @param {Snapshot} value */
  push(history, value) {
    history.push(value);
    let chars = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      chars += history[i].text.length;
      if (history.length - i > HISTORY_GROUPS || chars > HISTORY_CHARS && i < history.length - 1) { history.splice(0, i + 1); break; }
    }
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} kind @param {string} motion @param {string} operator @param {number} count @param {string} [glyph] */
  begin(c, s, kind, motion, operator, count, glyph = "") {
    this.finish(c, s);
    s.base = this.snapshot(c, s);
    s.record = { kind, motion, operator, count, glyph, register: s.register, width: 0, lines: false, edits: [] };
    s.insertOrigin = c.input.caret; s.expectedCaret = c.input.caret; s.editFrom = -1;
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} [text] */
  captureInsert(c, s, text = c.input.text) {
    if (s.record && !s.record.edits.length && s.editFrom >= 0) s.record.edits.push(s.editFrom - s.insertOrigin, s.editOldTo - s.editFrom, text.slice(s.editFrom, s.editNewTo));
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} [text] */
  finish(c, s, text = c.input.text) {
    if (!s.base) return;
    this.captureInsert(c, s, text);
    if (s.base.text !== text || s.base.spans.length !== c.spans.length) {
      this.push(s.undo, s.base);
      s.redo.length = 0;
      if (!s.replaying) s.last = s.record && s.record.edits.length && c.hasImages() ? null : s.record;
    }
    s.base = null; s.record = null; s.editFrom = -1;
  }
  /** @param {Buffer} c @param {BufferState} s @param {boolean} escape */
  finishInsert(c, s, escape) {
    this.captureInsert(c, s);
    if (escape && s.record && s.insertCount > 1 && s.record.edits.length) {
      const recipe = s.record;
      s.replaying = true;
      for (let i = 1; i < s.insertCount; i++) {
        if (recipe.motion === "o" || recipe.motion === "O") c.input.insert("\n");
        this.replayInsert(c, s, recipe);
      }
      s.replaying = false;
    }
    this.finish(c, s);
    if (escape && c.input.caret > lineStart(c.input.text, c.input.caret)) c.input.caret = s.nav.prev(c.input.text, c.input.caret);
    s.insertCount = 1;
  }
  /** @param {Buffer} c @param {BufferState} s @param {Snapshot} value */
  restore(c, s, value) {
    s.muted = true;
    try {
      c.input.replace(0, c.input.text.length, value.text);
      c.spans = value.spans.map(span => ({ ...span }));
      c.input.caret = clamp(value.text, value.caret);
      s.marks = value.marks ? new Map(value.marks) : null;
      c._invalidate();
    } finally { s.muted = false; }
  }
  /** @param {Buffer} c @param {BufferState} s @param {boolean} redo @param {number} count */
  history(c, s, redo, count) {
    this.finish(c, s);
    const from = redo ? s.redo : s.undo, to = redo ? s.undo : s.redo;
    for (let n = 0; n < count && from.length; n++) {
      const own = /** @type {Snapshot} */ (from.pop());
      const current = this.snapshot(c, s);
      current.caret = own.caret;
      this.push(to, current); this.restore(c, s, own);
    }
  }
  /** @param {BufferState} s @param {string} text @param {number} from @param {number} to @param {string} value */
  shiftMarks(s, text, from, to, value) {
    if (!s.marks) return;
    const delta = value.length - (to - from), start = lineStart(text, from), end = lineEnd(text, from);
    s.marks.forEach((at, name) => {
      const row = lineStart(text, at);
      if (row === start && to <= end && !value.includes("\n")) s.marks?.set(name, Math.min(at, end + delta));
      else if (!value && row >= from && lineEnd(text, row) < to) s.marks?.delete(name);
      else if (at >= to) s.marks?.set(name, at + delta);
      else if (at >= from) s.marks?.set(name, from);
    });
  }
  /** @param {Buffer} c @param {BufferState} s @param {number} count @returns {Range} */
  lines(c, s, count) {
    const text = c.input.text, r = s.range;
    r.from = lineStart(text, c.input.caret);
    r.to = r.from;
    for (let n = 0; n < count; n++) {
      const end = lineEnd(text, r.to), next = afterLine(text, end);
      r.to = end;
      if (next === text.length || n + 1 === count) break;
      r.to = next;
    }
    r.target = r.from; r.lines = true; r.inclusive = false;
    return r;
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} motion @param {number} count @param {string} [glyph] @param {boolean} [counted] @returns {Range | null} */
  motion(c, s, motion, count, glyph = "", counted = false) {
    const text = c.input.text, at = c.input.caret, nav = s.nav, r = s.range;
    let target = at, inclusive = false, lines = false;
    switch (motion) {
      case "h": case "left":
        for (let n = 0, start = lineStart(text, at); n < count && target > start; n++) target = nav.prev(text, target);
        break;
      case "l": case "right": case " ":
        for (let n = 0, end = lineEnd(text, at); n < count && target < end; n++) target = nav.next(text, target);
        break;
      case "0": case "home": target = lineStart(text, at); break;
      case "^": target = firstNonblank(text, at); break;
      case "$": case "end":
        for (let n = 1; n < count; n++) { const next = afterLine(text, lineEnd(text, target)); if (next === text.length) break; target = next; }
        target = lineEnd(text, target); if (target > lineStart(text, target)) target = nav.prev(text, target); inclusive = true; break;
      case "j": case "k": case "up": case "down": {
        let row = lineStart(text, at);
        const goal = c.goalCol == null ? measure(text.slice(row, at)) : c.goalCol;
        for (let n = 0; n < count; n++) {
          if (motion === "j" || motion === "down") { const next = afterLine(text, lineEnd(text, row)); if (next === row || next > text.length || row === text.length) break; row = next; }
          else { if (row === 0) break; row = lineStart(text, row - 1); }
        }
        target = caretAtCol(text, { start: row, end: lineEnd(text, row) }, goal); c.goalCol = goal; lines = true; break;
      }
      case "gj": case "gk":
        c.moveRow(motion === "gj" ? count : -count); target = c.input.caret; c.input.caret = at; break;
      case "gg": case "G": {
        let row = 0;
        if (motion === "G" && !counted) row = lineStart(text, text.length);
        else for (let n = 1; n < count; n++) { const next = afterLine(text, lineEnd(text, row)); if (next === row) break; row = next; }
        target = firstNonblank(text, row); lines = true; break;
      }
      case "w": case "W":
        if (s.operator === "c" && nav.cls(text, at) !== 0) { target = nav.wordEnd(text, at, count, motion === "W", true); inclusive = true; }
        else target = nav.wordStart(text, at, count, motion === "W", !!s.operator);
        break;
      case "b": case "B": target = nav.wordBack(text, at, count, motion === "B"); break;
      case "e": case "E": target = nav.wordEnd(text, at, count, motion === "E"); inclusive = true; break;
      case "ge": case "gE": target = nav.previousEnd(text, at, count, motion === "gE"); if (target < 0) return null; inclusive = true; break;
      case "f": case "F": case "t": case "T":
        target = nav.find(text, at, motion, glyph, count); if (target < 0) return null;
        s.findKind = motion; s.findGlyph = glyph; inclusive = motion === "f" || motion === "t"; break;
      case ";": case ",": {
        if (!s.findKind) return null;
        const kind = motion === ";" ? s.findKind : REVERSE_FIND[s.findKind];
        if (!kind) return null;
        target = nav.find(text, at, kind, s.findGlyph, count, true); if (target < 0) return null;
        inclusive = kind === "f" || kind === "t"; break;
      }
      case "%":
        if (counted) {
          if (count > 100) return null;
          let total = 1; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) total++;
          const wanted = Math.ceil(count * total / 100); let row = 0;
          for (let n = 1; n < wanted; n++) row = afterLine(text, lineEnd(text, row));
          target = firstNonblank(text, row); lines = true;
        } else { target = nav.match(text, at); if (target < 0) return null; inclusive = true; }
        break;
      case "{": case "}": target = nav.paragraph(text, at, motion === "}", count); break;
      case "'": case "`": {
        const mark = s.marks?.get(glyph); if (mark == null) return null;
        target = motion === "'" ? firstNonblank(text, mark) : snap(text, mark); lines = motion === "'"; break;
      }
      case "n": case "N": target = this.search(text, at, s, motion === "n" ? s.searchForward : !s.searchForward, count); if (target < 0) return null; break;
      case "*": case "#": case "g*": case "g#": {
        let pos = at, end = lineEnd(text, at);
        while (pos < end && nav.cls(text, pos) < 2) pos = nav.next(text, pos);
        if (pos === end) return null;
        const obj = nav.wordObject(text, pos, false, 1, false); if (!obj) return null;
        s.query = text.slice(obj.from, obj.to); s.searchForward = motion.includes("*"); s.searchWhole = motion.length === 1;
        target = this.search(text, at, s, s.searchForward, count); if (target < 0) return null; break;
      }
      default:
        if (motion.length === 2 && (motion[0] === "i" || motion[0] === "a")) return nav.object(text, at, motion[1], motion[0] === "a", count);
        return null;
    }
    r.from = Math.min(at, target); r.to = Math.max(at, target); r.target = target; r.lines = lines; r.inclusive = inclusive;
    return r;
  }
  /** @param {string} text @param {number} at @param {BufferState} s @param {boolean} forward @param {number} count */
  search(text, at, s, forward, count) {
    if (!s.query) return -1;
    for (let n = 0; n < count; n++) {
      let pos = at, remaining = text.length + 1;
      for (;;) {
        pos = forward ? text.indexOf(s.query, pos + 1) : text.lastIndexOf(s.query, pos - 1);
        if (pos < 0) pos = forward ? text.indexOf(s.query) : text.lastIndexOf(s.query);
        if (pos < 0 || --remaining < 0) return -1;
        const end = pos + s.query.length;
        if (snap(text, pos) === pos && snap(text, end) === end && (!s.searchWhole || (pos === 0 || s.nav.cls(text, s.nav.prev(text, pos)) < 2) && (end === text.length || s.nav.cls(text, end) < 2))) break;
      }
      at = pos;
    }
    return at;
  }
  /** @param {Buffer} c @param {BufferState} s @param {Range} r @param {boolean} [exact] */
  normalize(c, s, r, exact = false) {
    const text = c.input.text;
    if (r.lines) { r.from = lineStart(text, r.from); r.to = afterLine(text, lineEnd(text, r.to)); }
    else if (r.inclusive) { if (!s.nav.empty(text, r.to)) r.to = s.nav.next(text, r.to); }
    else if (!exact && r.to > r.from && lineStart(text, r.to) === r.to && lineStart(text, r.from) !== r.to && r.to <= text.length) {
      if (r.from <= firstNonblank(text, r.from)) { r.from = lineStart(text, r.from); r.lines = true; }
      else r.to = s.nav.prev(text, r.to);
    }
  }
  /** @param {Buffer} c @param {BufferState} s @param {Range} r @param {string} operator @param {number} [units] @param {boolean} [exact] */
  operate(c, s, r, operator, units = 1, exact = false) {
    this.normalize(c, s, r, exact);
    let from = r.from, to = r.to;
    const text = c.input.text;
    if (operator === "d" && !r.lines && lineStart(text, from) !== lineStart(text, to) && !text.slice(lineStart(text, from), from).trim() && !text.slice(to, lineEnd(text, to)).trim()) {
      r.lines = true; from = lineStart(text, from); to = afterLine(text, lineEnd(text, to));
    }
    if (operator === ">" || operator === "<") { from = lineStart(text, from); to = lineEnd(text, to > from ? s.nav.prev(text, to) : to); }
    let value = text.slice(from, to);
    if (operator === "y" || operator === "d" || operator === "c") {
      if (r.lines && value.endsWith("\n")) value = value.slice(0, value.endsWith("\r\n") ? -2 : -1);
      this.registers.save(value, r.lines, operator, s.register);
    }
    if (operator === "y") {
      c.input.caret = clamp(text, from);
      if (s.register !== "_") copy(value, "selection");
      return;
    }
    if (operator === "d" || operator === "c") {
      if (r.lines && operator === "d" && to === text.length && from > 0 && !text.endsWith("\n")) from = s.nav.prev(text, from);
      if (r.lines && operator === "c") {
        const last = to > from ? s.nav.prev(text, to) : to;
        to = lineEnd(text, last);
        from = r.from;
      }
      c.input.replace(from, to, "");
      c.input.caret = snap(c.input.text, from);
      if (operator === "c") { s.mode = "insert"; s.insertOrigin = c.input.caret; }
      else c.input.caret = clamp(c.input.text, r.lines ? firstNonblank(c.input.text, c.input.caret) : c.input.caret);
    } else {
      let replacement = value;
      if (operator === "gu") replacement = value.toLowerCase();
      else if (operator === "gU") replacement = value.toUpperCase();
      else if (operator === "g~") replacement = this.toggle(value, s.nav);
      else replacement = this.shift(value, operator === ">", units);
      c.input.replace(from, to, replacement);
      c.input.caret = clamp(c.input.text, snap(c.input.text, from));
      if (operator === ">" || operator === "<") c.input.caret = clamp(c.input.text, firstNonblank(c.input.text, from));
    }
    c.goalCol = null;
  }
  /** @param {string} value @param {Navigation} nav */
  toggle(value, nav) {
    let result = "";
    for (let at = 0; at < value.length;) {
      const next = nav.next(value, at), glyph = value.slice(at, next), lower = glyph.toLowerCase();
      result += glyph === lower ? glyph.toUpperCase() : lower; at = next;
    }
    return result;
  }
  /** @param {string} value @param {boolean} right @param {number} count */
  shift(value, right, count) {
    const rows = value.split("\n");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; if (!row.length) continue;
      let at = 0, col = 0;
      while (at < row.length && (row[at] === " " || row[at] === "\t")) { col += row[at] === "\t" ? 2 - col % 2 : 1; at++; }
      rows[i] = " ".repeat(right ? col + count * 2 : Math.max(0, col - count * 2)) + row.slice(at);
    }
    return rows.join("\n");
  }
  /** @param {Buffer} c @param {BufferState} s @returns {Range} */
  visual(c, s) {
    const r = s.range;
    r.from = Math.min(s.anchor, c.input.caret); r.to = Math.max(s.anchor, c.input.caret); r.target = r.from;
    r.lines = s.mode === "visual-line"; r.inclusive = true;
    return r;
  }
  /** @param {Buffer} c @param {BufferState} s */
  rememberVisual(c, s) {
    s.visualFrom = s.anchor; s.visualTo = c.input.caret; s.visualLines = s.mode === "visual-line"; s.haveVisual = true;
    s.paintProjection = null; s.segments.length = 0;
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} motion @param {number} count @param {string} glyph @param {boolean} counted */
  complete(c, s, motion, count, glyph = "", counted = false) {
    s.nav.failureTarget = -1;
    const op = s.operator, r = motion === "line" ? this.lines(c, s, count) : this.motion(c, s, motion, count, glyph, counted);
    if (!r) { if (s.nav.failureTarget >= 0) c.input.caret = s.nav.failureTarget; this.reset(s); return; }
    if (op) {
      if (op !== "y") this.begin(c, s, "operator", motion, op, count, glyph);
      this.operate(c, s, r, op, 1, motion.length === 2 && (motion[0] === "i" || motion[0] === "a"));
      if (s.mode !== "insert") this.finish(c, s);
    } else {
      if (s.mode.startsWith("visual") && motion.length === 2 && (motion[0] === "i" || motion[0] === "a")) { s.anchor = r.from; c.input.caret = s.nav.prev(c.input.text, r.to); s.mode = "visual"; }
      else c.input.caret = clamp(c.input.text, r.target);
      if (!VERTICAL.has(motion)) c.goalCol = null;
    }
    this.reset(s);
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} key @param {number} count */
  insert(c, s, key, count) {
    this.begin(c, s, "insert", key, "", count);
    const t = c.input, end = lineEnd(t.text, t.caret);
    if (key === "a") t.caret = Math.min(end, s.nav.next(t.text, t.caret));
    else if (key === "I") t.caret = firstNonblank(t.text, t.caret);
    else if (key === "A") t.caret = end;
    else if (key === "o" || key === "O") {
      const at = key === "o" ? end : lineStart(t.text, t.caret);
      t.replace(at, at, "\n"); t.caret = at + (key === "o" ? 1 : 0);
    }
    s.insertOrigin = t.caret; s.expectedCaret = t.caret; s.insertCount = count; s.mode = "insert";
    this.reset(s);
    this.tui.root.invalidate();
  }
  /** @param {Buffer} c @param {BufferState} s @param {Recipe} recipe */
  replayInsert(c, s, recipe) {
    const origin = c.input.caret;
    for (let i = 0; i < recipe.edits.length; i += 3) {
      const from = snap(c.input.text, Math.max(0, Math.min(c.input.text.length, origin + /** @type {number} */ (recipe.edits[i]))));
      const to = snap(c.input.text, Math.min(c.input.text.length, from + /** @type {number} */ (recipe.edits[i + 1])));
      const value = /** @type {string} */ (recipe.edits[i + 2]);
      c.input.replace(from, to, value);
    }
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} key @param {number} count */
  put(c, s, key, count) {
    const entry = this.registers.read(s.register); if (!entry || !entry.text && !entry.linewise) return;
    const storedText = entry.text, storedLines = entry.linewise;
    this.begin(c, s, "put", key, "", count);
    const t = c.input, after = key === "p";
    if (s.mode.startsWith("visual")) {
      const r = this.visual(c, s); this.normalize(c, s, r);
      const from = r.from, to = r.to, lines = r.lines;
      const value = storedLines ? (lines ? "" : "\n") + Array(count).fill(storedText).join("\n") + (lines && c.input.text[to - 1] !== "\n" ? "" : "\n") : storedText.repeat(count) + (lines && c.input.text[to - 1] === "\n" ? "\n" : "");
      const old = t.text.slice(from, to);
      if (s.record) { s.record.kind = "visual-put"; s.record.width = lines ? c.input.text.slice(from, to).split("\n").length - (c.input.text[to - 1] === "\n" ? 1 : 0) : s.nav.distance(c.input.text, from, to); s.record.lines = lines; }
      this.rememberVisual(c, s);
      if (key === "p") this.registers.save(lines && old.endsWith("\n") ? old.slice(0, -1) : old, lines, "d");
      t.replace(from, to, value); t.caret = clamp(t.text, snap(t.text, storedLines || lines ? firstNonblank(t.text, from + (lines ? 0 : 1)) : value.includes("\n") ? from : s.nav.prev(t.text, from + value.length))); s.mode = "normal";
    } else if (storedLines) {
      const at = after ? lineEnd(t.text, t.caret) : lineStart(t.text, t.caret);
      const body = Array(count).fill(storedText).join("\n");
      t.replace(at, at, after ? "\n" + body : body + "\n"); t.caret = clamp(t.text, firstNonblank(t.text, at + (after ? 1 : 0)));
    } else {
      const at = after ? Math.min(lineEnd(t.text, t.caret), s.nav.next(t.text, t.caret)) : t.caret;
      const value = storedText.repeat(count);
      t.replace(at, at, value);
      t.caret = clamp(t.text, value.includes("\n") ? at : s.nav.prev(t.text, snap(t.text, at + value.length)));
    }
    this.finish(c, s); this.reset(s);
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} glyph @param {number} count */
  replace(c, s, glyph, count) {
    let from = c.input.caret, to = from;
    const visual = s.mode.startsWith("visual");
    if (visual) { const r = this.visual(c, s); this.normalize(c, s, r); from = r.from; to = r.to; }
    else {
      const end = lineEnd(c.input.text, from);
      for (let n = 0; n < count; n++) { if (to >= end) return; to = s.nav.next(c.input.text, to); }
    }
    this.begin(c, s, "replace", "r", "", count, glyph);
    if (visual) { this.rememberVisual(c, s); s.mode = "normal"; }
    let value = "";
    if (visual) for (let at = from; at < to; at = s.nav.next(c.input.text, at)) value += c.input.text[at] === "\n" ? "\n" : glyph;
    else value = glyph === "\n" ? glyph : glyph.repeat(count);
    c.input.replace(from, to, value);
    c.input.caret = clamp(c.input.text, snap(c.input.text, visual ? from : glyph === "\n" ? from + 1 : s.nav.prev(c.input.text, from + value.length)));
    this.finish(c, s);
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} key @param {number} count */
  join(c, s, key, count) {
    const text = c.input.text;
    let from = lineStart(text, c.input.caret), to = lineEnd(text, from), caret = to, value = text.slice(from, to);
    if (s.mode.startsWith("visual")) { const r = this.visual(c, s); count = text.slice(r.from, r.to).split("\n").length; from = lineStart(text, r.from); to = lineEnd(text, from); value = text.slice(from, to); this.rememberVisual(c, s); s.mode = "normal"; }
    if (to === text.length) return;
    this.begin(c, s, "join", key, "", count);
    for (let n = 1; n < Math.max(2, count) && to < text.length; n++) {
      const start = afterLine(text, to), end = lineEnd(text, start);
      let body = text.slice(start, end);
      if (key === "J") body = body.replace(/^[ \t]+/, "");
      caret = from + value.length;
      if (key === "J" && value && body && !/[ \t]$/.test(value) && body[0] !== ")") value += " ";
      value += body; to = end;
    }
    c.input.replace(from, to, value); c.input.caret = clamp(c.input.text, snap(c.input.text, caret)); this.finish(c, s);
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} key @param {number} count */
  simple(c, s, key, count) {
    if (key === "J" || key === "gJ") { this.join(c, s, key, count); return; }
    if (key === "~") {
      const r = s.range; r.from = c.input.caret; r.to = r.from;
      for (let n = 0, end = lineEnd(c.input.text, r.from); n < count && r.to < end; n++) r.to = s.nav.next(c.input.text, r.to);
      r.lines = false; r.inclusive = false;
      const dest = r.to; this.begin(c, s, "simple", key, "", count); this.operate(c, s, r, "g~"); c.input.caret = clamp(c.input.text, dest); this.finish(c, s); return;
    }
    const op = key === "s" || key === "S" || key === "C" ? "c" : key === "Y" ? "y" : "d";
    s.operator = op;
    if (key === "S" || key === "Y") this.complete(c, s, "line", count);
    else this.complete(c, s, key === "D" || key === "C" ? "$" : key === "X" ? "h" : "l", count);
    if (s.last && !s.base && op !== "y") { s.last.kind = "simple"; s.last.motion = key; }
    if (s.record) { s.record.kind = "simple"; s.record.motion = key; }
  }
  /** @param {Buffer} c @param {BufferState} s @param {number} count @param {boolean} counted */
  repeat(c, s, count, counted) {
    const last = s.last; if (!last) return;
    const n = counted ? count : last.count;
    s.register = last.register; s.replaying = true;
    if (last.kind === "operator") { s.operator = last.operator; this.complete(c, s, last.motion, n, last.glyph, true); }
    else if (last.kind === "simple") this.simple(c, s, last.motion, n);
    else if (last.kind === "visual-put") {
      this.begin(c, s, "visual-put", last.motion, "d", n);
      const r = last.lines ? this.lines(c, s, last.width) : s.range;
      if (!last.lines) { r.from = c.input.caret; r.to = r.from; for (let k = 0; k < last.width; k++) r.to = s.nav.next(c.input.text, r.to); r.target = r.from; r.lines = false; r.inclusive = false; }
      this.operate(c, s, r, "d", 1, true); this.finish(c, s);
    }
    else if (last.kind === "put") this.put(c, s, last.motion, n);
    else if (last.kind === "replace") this.replace(c, s, last.glyph, n);
    else if (last.kind === "join") this.join(c, s, last.motion, n);
    else if (last.kind === "visual") {
      s.mode = last.lines ? "visual-line" : "visual"; s.anchor = c.input.caret;
      for (let k = 0; k < last.width; k++) c.input.caret = last.lines ? afterLine(c.input.text, lineEnd(c.input.text, c.input.caret)) : s.nav.next(c.input.text, c.input.caret);
      c.input.caret = clamp(c.input.text, c.input.caret);
      this.visualOperate(c, s, last.operator, n);
    } else this.insert(c, s, last.motion, n);
    if (s.mode === "insert") {
      for (let i = 0; i < (last.kind === "insert" ? n : 1); i++) { if (i && (last.motion === "o" || last.motion === "O")) c.input.insert("\n"); this.replayInsert(c, s, last); }
      s.insertCount = 1; this.finishInsert(c, s, true); s.mode = "normal";
    }
    s.replaying = false; s.last = last; this.reset(s);
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} op @param {number} count */
  visualOperate(c, s, op, count) {
    const r = this.visual(c, s), lines = r.lines, width = lines ? c.input.text.slice(r.from, r.to).split("\n").length - 1 : s.nav.distance(c.input.text, r.from, r.to);
    if (op !== "y") this.begin(c, s, "visual", "", op, count);
    if (s.record) { s.record.width = width; s.record.lines = lines; }
    this.rememberVisual(c, s); s.mode = "normal";
    this.operate(c, s, r, op, count);
    if (s.mode !== "insert") this.finish(c, s);
    this.reset(s);
  }
  /** Handle a composer stroke. True means that the FSM consumed it. Borrows the event. Host failures throw. @param {Buffer} c @param {Parameters<Tui["keymap"]["onKey"]>[0]} ev */
  onKey(c, ev) {
    const s = this.state(c), stroke = keys.strokeOf(ev);
    if (stroke === "esc" || stroke === "ctrl+[") {
      if (s.mode === "insert") { this.finishInsert(c, s, true); s.mode = "normal"; c.input.caret = clamp(c.input.text, c.input.caret); }
      else if (s.mode.startsWith("visual")) { this.rememberVisual(c, s); s.mode = "normal"; }
      this.reset(s); this.tui.root.invalidate(); return true;
    }
    if (stroke === "tab" || (ev.mods & 14) !== 0 && stroke !== "ctrl+r" && stroke !== "alt+/") { this.reset(s); return false; }
    if (s.phase === "register" || s.phase === "insert-register") {
      const insert = s.phase === "insert-register"; s.phase = "ready"; if (s.pendingRoute) { s.pendingRoute(); s.pendingRoute = null; }
      if (REGISTER_NAME.test(stroke)) {
        if (insert) { const entry = this.registers.read(stroke); if (entry) c.input.insert(entry.text + (entry.linewise ? "\n" : "")); }
        else s.register = stroke;
      } else this.reset(s);
      return true;
    }
    if (s.mode === "insert") {
      if (stroke === "ctrl+r") { s.phase = "insert-register"; s.pendingRoute = this.tui.route.add("keymap", "composer && !overlay"); return true; }
      return false;
    }
    if (s.phase === "ready" && !s.operator && !s.leading && !s.count && (stroke === "w" || stroke === "b" || stroke === "e" || stroke === "W" || stroke === "B" || stroke === "E")) {
      this.moveWord(c, s, stroke); return true;
    }
    if (MODIFIED.test(stroke)) {
      if (stroke === "ctrl+r") { this.history(c, s, true, s.count || s.leading || 1); this.reset(s); return true; }
      if (stroke === "alt+/") { this.openSearch(c, s); return true; }
      this.reset(s); return false;
    }
    const handled = this.parse(c, s, stroke);
    if (s.mode.startsWith("visual") && !s.drawOff) {
      const editor = this;
      s.drawOff = this.ctx.advise(c, "draw", "after", function (focused) { if (focused) editor.drawVisual(this, s); });
    }
    return handled;
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} stroke */
  moveWord(c, s, stroke) {
    const text = c.input.text, at = c.input.caret;
    c.input.caret = clamp(text, stroke === "w" || stroke === "W" ? s.nav.wordStart(text, at, 1, stroke === "W") : stroke === "b" || stroke === "B" ? s.nav.wordBack(text, at, 1, stroke === "B") : s.nav.wordEnd(text, at, 1, stroke === "E"));
    c.goalCol = null;
  }
  /** @param {Buffer} c @param {BufferState} s @param {string} stroke */
  parse(c, s, stroke) {
    const counted = !!(s.leading || s.count), count = (s.leading || 1) * (s.count || 1);
    if (s.phase === "character") {
      const kind = s.prefix;
      if (stroke === "enter" && kind === "r") { this.replace(c, s, "\n", count); this.reset(s); return true; }
      if (stroke && s.nav.next(stroke, 0) === stroke.length) {
        if (kind === "r") this.replace(c, s, stroke, count);
        else this.complete(c, s, kind, count, stroke, counted);
      }
      this.reset(s); return true;
    }
    if (s.phase === "mark") {
      if (MARK_NAME.test(stroke)) {
        if (s.prefix === "m") { if (!s.marks) s.marks = new Map(); s.marks.set(stroke, c.input.caret); }
        else this.complete(c, s, s.prefix, count, stroke, counted);
      }
      this.reset(s); return true;
    }
    if (s.phase === "text-object") { this.complete(c, s, s.prefix + stroke, count, "", counted); return true; }
    if (s.phase === "prefix") {
      const prefix = s.prefix; s.phase = "ready";
      if (prefix === "g" && (stroke === "u" || stroke === "U" || stroke === "~")) { s.operator = "g" + stroke; s.leading = counted ? count : 0; s.count = 0; s.phase = "operator"; return true; }
      if (prefix === "g" && stroke === "v" && !s.operator && s.haveVisual) {
        s.mode = s.visualLines ? "visual-line" : "visual"; s.anchor = snap(c.input.text, Math.min(s.visualFrom, c.input.text.length)); c.input.caret = clamp(c.input.text, snap(c.input.text, Math.min(s.visualTo, c.input.text.length))); this.reset(s); return true;
      }
      if (prefix === "g" && stroke === "J" && !s.operator) { this.join(c, s, "gJ", count); this.reset(s); return true; }
      this.complete(c, s, prefix + stroke, count, "", counted); return true;
    }
    if (stroke.length === 1 && stroke >= "0" && stroke <= "9" && (stroke !== "0" || s.count > 0)) {
      s.count = s.count * 10 + Number(stroke);
      if ((s.leading || 1) * s.count > MAX_COUNT) { this.reset(s); this.ctx.interaction.notify("Vim count exceeds 10000", "warn"); }
      return true;
    }
    if (stroke === '"') { s.phase = "register"; return true; }
    if (stroke === "g") { s.prefix = "g"; s.phase = "prefix"; return true; }
    if (stroke === "f" || stroke === "F" || stroke === "t" || stroke === "T" || stroke === "r" && !s.operator) { s.prefix = stroke; s.phase = "character"; return true; }
    if (stroke === "m" && !s.operator || stroke === "'" || stroke === "`") { s.prefix = stroke; s.phase = "mark"; return true; }
    if (s.operator) {
      if (stroke === "i" || stroke === "a") { s.prefix = stroke; s.phase = "text-object"; return true; }
      const doubled = stroke === s.operator || s.operator === "gu" && stroke === "u" || s.operator === "gU" && stroke === "U" || s.operator === "g~" && stroke === "~";
      this.complete(c, s, doubled ? "line" : stroke, count, "", counted); return true;
    }
    if (s.mode.startsWith("visual")) {
      if (stroke === "o") { const old = s.anchor; s.anchor = c.input.caret; c.input.caret = old; this.reset(s); return true; }
      if (stroke === "i" || stroke === "a") { s.prefix = stroke; s.phase = "text-object"; return true; }
      if (stroke === "d" || stroke === "x" || stroke === "c" || stroke === "y" || stroke === "u" || stroke === "U" || stroke === "~" || stroke === ">" || stroke === "<") {
        this.visualOperate(c, s, stroke === "x" ? "d" : stroke === "u" ? "gu" : stroke === "U" ? "gU" : stroke === "~" ? "g~" : stroke, count); return true;
      }
    }
    if (stroke === "v" || stroke === "V") {
      const next = stroke === "v" ? "visual" : "visual-line";
      if (s.mode === next) { this.rememberVisual(c, s); s.mode = "normal"; }
      else { if (!s.mode.startsWith("visual")) s.anchor = c.input.caret; s.mode = next; }
      this.reset(s); return true;
    }
    if (stroke === "d" || stroke === "c" || stroke === "y" || stroke === ">" || stroke === "<") { s.operator = stroke; s.leading = counted ? count : 0; s.count = 0; s.phase = "operator"; return true; }
    if (INSERT_KEYS.has(stroke)) { this.insert(c, s, stroke, count); return true; }
    if (SIMPLE_KEYS.has(stroke)) { this.simple(c, s, stroke, count); this.reset(s); return true; }
    if (stroke === "p" || stroke === "P") { this.put(c, s, stroke, count); return true; }
    if (stroke === "u") { this.history(c, s, false, count); this.reset(s); return true; }
    if (stroke === ".") { this.repeat(c, s, count, counted); return true; }
    if (stroke === "/") { if (s.mode.startsWith("visual")) this.rememberVisual(c, s); this.insert(c, s, "i", 1); c.input.insert("/"); return true; }
    if (stroke === "?") { this.openSearch(c, s, false); return true; }
    if (stroke === "enter") { c.submit(); this.reset(s); return true; }
    if (stroke.length !== 1 && !NAMED_MOTIONS.has(stroke)) { this.reset(s); return false; }
    this.complete(c, s, stroke, count, "", counted);
    // Unrecognized plain strokes never become accidental text input.
    return true;
  }
  /** @param {Buffer} c @param {BufferState} s @param {boolean} [forward] */
  openSearch(c, s, forward = true) {
    this.reset(s);
    const textBorrow = c.input.text, caret = c.input.caret;
    this.ctx.interaction.input("Search draft (literal, case-sensitive)", s.query).then(value => {
      if (!this.ctx.alive || value == null || c.input.text !== textBorrow || c.input.caret !== caret || (/** @type {{ composer?: Buffer } | null} */ (this.tui.root.active))?.composer !== c || this.tui.root.focused !== this.tui.root.active || (/** @type {{ focus?: string } | null} */ (this.tui.root.active))?.focus !== "composer") return;
      if (value) s.query = value;
      s.searchForward = forward; s.searchWhole = false;
      this.complete(c, s, "n", 1); this.tui.root.invalidatePaint();
    }).catch(error => { if (this.ctx.alive) this.ctx.interaction.notify(String(error), "warn"); });
  }
  /** @param {Buffer} c @param {BufferState} s */
  drawVisual(c, s) {
    const rect = c.rect; if (rect.w <= 0 || rect.h <= 0) return;
    const projection = c._projection(), width = c._textWidth(rect.w), r = this.visual(c, s);
    this.normalize(c, s, r);
    if (projection !== s.paintProjection || r.from !== s.paintFrom || r.to !== s.paintTo || width !== s.paintWidth || c.scroll !== s.paintScroll || rect.h !== s.paintHeight) this.buildPaint(c, s, projection, width, r);
    for (let i = 0; i < s.segments.length; i++) {
      const segment = s.segments[i]; paint(rect.x + rect.w - width + segment.offset, rect.y + segment.row, segment.value, "VimSelection");
    }
  }
  /** @param {Buffer} c @param {BufferState} s @param {ReturnType<Buffer["_projection"]>} projection @param {number} width @param {Range} r */
  buildPaint(c, s, projection, width, r) {
    const from = c._toDisplay(r.from), to = c._toDisplay(r.to), rows = c._rowsAt(width);
    s.segments.length = 0;
    for (let i = 0; i < c.rect.h && i + c.scroll < rows.length; i++) {
      const row = rows[i + c.scroll], lo = Math.max(row.start, from), hi = Math.min(row.end, to);
      if (hi > lo) s.segments.push({ row: i, offset: measure(projection.text.slice(row.start, lo)), value: projection.text.slice(lo, hi) });
      else if (s.mode === "visual-line" && row.start === row.end && row.start >= from && row.start <= to) s.segments.push({ row: i, offset: 0, value: " " });
    }
    s.paintProjection = projection; s.paintFrom = r.from; s.paintTo = r.to; s.paintWidth = width; s.paintScroll = c.scroll; s.paintHeight = c.rect.h;
  }
}
