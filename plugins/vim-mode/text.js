//! Vim motion classes and half-open text ranges on whole graphemes.
import { graphemes, prevGrapheme } from "yuke:ui";
import { vimClass } from "./unicode-classes.js";
const NARROW = /^[\x00-\xff]*$/;
const narrowClass = new Uint8Array(256);
const EMPTY_CELLS = new Int32Array(0);
for (let code = 0; code < 256; code++) narrowClass[code] = code === 10 ? 0 : vimClass(code);

/** @typedef {{ from: number, to: number, target: number, lines: boolean, inclusive: boolean }} Range */

/** Logical line start. The string is borrowed. No null result or failure. @param {string} text @param {number} at */
export function lineStart(text, at) { return at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1; }
/** Logical line end, before CRLF or LF. The string is borrowed. No null result or failure. @param {string} text @param {number} at */
export function lineEnd(text, at) {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end > 0 && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
}
/** Offset after a line ending. The string is borrowed. No null result or failure. @param {string} text @param {number} end */
export function afterLine(text, end) { return end === text.length ? end : end + (text.charCodeAt(end) === 13 ? 2 : 1); }
/** First nonblank of a logical line. The string is borrowed. No null result or failure. @param {string} text @param {number} at */
export function firstNonblank(text, at) {
  let start = lineStart(text, at);
  const end = lineEnd(text, start);
  while (start < end && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
  return start;
}
/** Normal-mode caret, before the last grapheme on a nonempty line. Borrows text. Host allocation failure throws. @param {string} text @param {number} at */
export function clamp(text, at) {
  at = Math.max(0, Math.min(at, text.length));
  const end = lineEnd(text, at);
  return at >= end && end > lineStart(text, at) ? prevGrapheme(text, end) : at;
}
/** Snap an edit result before an enclosing cluster. Borrows text. Host allocation failure throws. @param {string} text @param {number} at */
export function snap(text, at) {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  const left = text.charCodeAt(at - 1), right = text.charCodeAt(at);
  if (left < 256 && right < 256 && !(left === 13 && right === 10)) return at;
  const cells = graphemes(text);
  let before = 0;
  for (let i = 0; i < cells.length && cells[i] <= at; i += 3) before = cells[i];
  return before;
}

/** A navigation owner with one Unicode segmentation cache. Text arguments are borrowed. Host allocation failures throw. */
export class Navigation {
  constructor() {
    this.textBorrow = "";
    this.failureTarget = -1;
    this.narrowTextBorrow = "";
    this.isNarrow = true;
    /** @type {Int32Array} */ this.cellsOwn = EMPTY_CELLS;
  }
  /** Release the cached text and segmentation. No failure. */
  clear() { this.textBorrow = ""; this.narrowTextBorrow = ""; this.isNarrow = true; this.cellsOwn = EMPTY_CELLS; }
  /** @param {string} text */
  narrow(text) {
    if (this.narrowTextBorrow === text) return this.isNarrow;
    this.narrowTextBorrow = text; this.isNarrow = NARROW.test(text); return this.isNarrow;
  }
  /** @param {string} text */
  cells(text) {
    if (this.textBorrow === text) return this.cellsOwn;
    this.textBorrow = text;
    this.cellsOwn = graphemes(text);
    return this.cellsOwn;
  }
  /** @param {string} text @param {number} at */
  next(text, at) {
    if (at >= text.length) return text.length;
    const a = text.charCodeAt(at), b = text.charCodeAt(at + 1);
    if (a < 256 && (at + 1 === text.length || b < 256)) return at + (a === 13 && b === 10 ? 2 : 1);
    return this.unicodeStep(text, at, true);
  }
  /** @param {string} text @param {number} at */
  prev(text, at) {
    if (at <= 0) return 0;
    const a = text.charCodeAt(at - 1), b = text.charCodeAt(at - 2);
    if (a < 256 && (at === 1 || b < 256)) return at - (a === 10 && b === 13 ? 2 : 1);
    return this.unicodeStep(text, at, false);
  }
  /** @param {string} text @param {number} at @param {boolean} forward */
  unicodeStep(text, at, forward) {
    const cells = this.cells(text);
    let lo = 0, hi = cells.length / 3 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, start = cells[mid * 3];
      if (start < at) lo = mid + 1;
      else if (start > at) hi = mid - 1;
      else return forward ? start + cells[mid * 3 + 1] : mid > 0 ? cells[(mid - 1) * 3] : 0;
    }
    return forward ? text.length : hi >= 0 ? cells[hi * 3] : 0;
  }
  /** @param {string} text @param {number} at */
  after(text, at) {
    const cells = this.cells(text);
    let lo = 0, hi = cells.length / 3 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, start = cells[mid * 3];
      if (start < at) lo = mid + 1;
      else if (start > at) hi = mid - 1;
      else return at;
    }
    return hi >= 0 ? cells[hi * 3] + cells[hi * 3 + 1] : 0;
  }
  /** @param {string} text @param {number} from @param {number} to */
  distance(text, from, to) {
    let count = 0;
    while (from < to) { from = this.next(text, from); count++; }
    return count;
  }
  /** @param {string} text @param {number} at @param {boolean} [big] */
  cls(text, at, big = false) {
    if (at >= text.length || text.charCodeAt(at) === 10 || (text.charCodeAt(at) === 13 && text.charCodeAt(at + 1) === 10)) return 0;
    const code = /** @type {number} */ (text.codePointAt(at));
    const cls = vimClass(code);
    return big && cls !== 0 ? 1 : cls;
  }
  /** @param {string} text @param {number} at */
  empty(text, at) { return lineStart(text, at) === at && lineEnd(text, at) === at; }
  /** @param {string} text @param {number} at @param {number} count @param {boolean} [big] @param {boolean} [operator] */
  wordStart(text, at, count = 1, big = false, operator = false) {
    if (this.narrow(text)) return this.narrowStart(text, at, count, big, operator);
    for (let n = 0; n < count && at < text.length; n++) {
      const cls = this.cls(text, at, big), end = lineEnd(text, at), origin = at;
      at = this.next(text, at);
      if (operator && n === count - 1 && at >= end) return origin === end ? at : end;
      if (cls !== 0) {
        while (at < text.length && this.cls(text, at, big) === cls) {
          at = this.next(text, at);
          if (operator && n === count - 1 && at >= end) return end;
        }
      }
      while (at < text.length && this.cls(text, at, big) === 0) {
        if (this.empty(text, at)) break;
        if (operator && n === count - 1 && at >= end) return end;
        at = this.next(text, at);
      }
    }
    return at;
  }
  /** @param {string} text @param {number} at @param {number} count @param {boolean} [big] @returns {number} */
  wordBack(text, at, count = 1, big = false) {
    if (this.narrow(text)) return this.narrowBack(text, at, count, big);
    for (let n = 0; n < count && at > 0; n++) {
      at = this.prev(text, at);
      while (at > 0 && this.cls(text, at, big) === 0 && !this.empty(text, at)) at = this.prev(text, at);
      if (this.empty(text, at)) continue;
      const cls = this.cls(text, at, big);
      while (at > 0) {
        const prev = this.prev(text, at);
        if (this.cls(text, prev, big) !== cls) break;
        at = prev;
      }
    }
    return at;
  }
  /** @param {string} text @param {number} at @param {number} count @param {boolean} [big] @param {boolean} [stay] */
  wordEnd(text, at, count = 1, big = false, stay = false) {
    if (this.narrow(text)) return this.narrowEnd(text, at, count, big, stay);
    for (let n = 0; n < count && at < text.length; n++) {
      if (!stay || n !== 0) at = this.next(text, at);
      while (at < text.length && this.cls(text, at, big) === 0) at = this.next(text, at);
      if (at === text.length) return at;
      const cls = this.cls(text, at, big);
      let next = this.next(text, at);
      while (next < text.length && this.cls(text, next, big) === cls) { at = next; next = this.next(text, at); }
    }
    return at;
  }
  /** @param {string} text @param {number} at @param {number} count @param {boolean} big @param {boolean} operator */
  narrowStart(text, at, count, big, operator) {
    for (let n = 0; n < count && at < text.length; n++) {
      const code = text.charCodeAt(at), cls = code === 13 && text.charCodeAt(at + 1) === 10 ? 0 : narrowClass[code];
      const end = operator && n + 1 === count ? lineEnd(text, at) : text.length;
      const empty = at === end;
      at += code === 13 && text.charCodeAt(at + 1) === 10 ? 2 : 1;
      if (operator && n + 1 === count && at >= end) return empty ? at : end;
      if (cls !== 0) while (at < end) {
        const next = text.charCodeAt(at), nextClass = next === 13 && text.charCodeAt(at + 1) === 10 ? 0 : narrowClass[next];
        if (big ? nextClass === 0 : nextClass !== cls) break;
        at++;
      }
      while (at < text.length) {
        const next = text.charCodeAt(at);
        if ((next === 10 || next === 13 && text.charCodeAt(at + 1) === 10) && (at === 0 || text.charCodeAt(at - 1) === 10)) break;
        if (operator && n + 1 === count && at >= end) return end;
        if (next === 13 && text.charCodeAt(at + 1) === 10) at += 2;
        else { if (narrowClass[next] !== 0) break; at++; }
      }
    }
    return at;
  }
  /** @param {string} text @param {number} at @param {number} count @param {boolean} big */
  narrowBack(text, at, count, big) {
    for (let n = 0; n < count && at > 0; n++) {
      at -= text.charCodeAt(at - 1) === 10 && text.charCodeAt(at - 2) === 13 ? 2 : 1;
      while (at > 0) {
        const code = text.charCodeAt(at);
        if ((code === 10 || code === 13 && text.charCodeAt(at + 1) === 10) && text.charCodeAt(at - 1) === 10) break;
        if (code === 13 && text.charCodeAt(at + 1) === 10 || narrowClass[code] === 0) at -= text.charCodeAt(at - 1) === 10 && text.charCodeAt(at - 2) === 13 ? 2 : 1;
        else break;
      }
      const cls = narrowClass[text.charCodeAt(at)];
      if (cls === 0 || text.charCodeAt(at) === 13 && text.charCodeAt(at + 1) === 10) continue;
      while (at > 0) {
        const prev = at - (text.charCodeAt(at - 1) === 10 && text.charCodeAt(at - 2) === 13 ? 2 : 1), code = text.charCodeAt(prev);
        const prevClass = code === 13 && text.charCodeAt(prev + 1) === 10 ? 0 : narrowClass[code];
        if (big ? prevClass === 0 : prevClass !== cls) break;
        at = prev;
      }
    }
    return at;
  }
  /** @param {string} text @param {number} at @param {number} count @param {boolean} big @param {boolean} stay */
  narrowEnd(text, at, count, big, stay) {
    for (let n = 0; n < count && at < text.length; n++) {
      if (!stay || n !== 0) at += text.charCodeAt(at) === 13 && text.charCodeAt(at + 1) === 10 ? 2 : 1;
      while (at < text.length) {
        const code = text.charCodeAt(at);
        if (code === 13 && text.charCodeAt(at + 1) === 10) at += 2;
        else { if (narrowClass[code] !== 0) break; at++; }
      }
      if (at === text.length) return at;
      const cls = narrowClass[text.charCodeAt(at)];
      while (at + 1 < text.length) {
        const code = text.charCodeAt(at + 1), nextClass = code === 13 && text.charCodeAt(at + 2) === 10 ? 0 : narrowClass[code];
        if (big ? nextClass === 0 : nextClass !== cls) break;
        at++;
      }
    }
    return at;
  }
  /** @param {string} text @param {number} at @param {number} count @param {boolean} [big] */
  previousEnd(text, at, count = 1, big = false) {
    const partial = at > 0 && this.cls(text, at, big) !== 0;
    for (let n = 0; n < count; n++) {
      if (at <= 0) { this.failureTarget = 0; return partial ? 0 : -1; }
      const cls = this.cls(text, at, big);
      at = this.prev(text, at);
      if (cls !== 0) {
        while (this.cls(text, at, big) === cls) {
          if (at === 0) { this.failureTarget = 0; return partial ? 0 : -1; }
          at = this.prev(text, at);
        }
      }
      while (at > 0 && this.cls(text, at, big) === 0 && !this.empty(text, at)) at = this.prev(text, at);
    }
    return at;
  }
  /** @param {string} text @param {number} at @param {string} kind @param {string} glyph @param {number} count @param {boolean} [repeat] */
  find(text, at, kind, glyph, count, repeat = false) {
    const forward = kind === "f" || kind === "t", till = kind === "t" || kind === "T";
    const start = lineStart(text, at), end = lineEnd(text, at);
    const scalar = glyph.length === (/** @type {number} */ (glyph.codePointAt(0)) < 0x10000 ? 1 : 2);
    let pos = at;
    for (let n = 0; n < count; n++) {
      for (;;) {
        const before = pos;
        pos = forward ? this.next(text, pos) : this.prev(text, pos);
        if (pos === before) return -1;
        if (pos >= end || pos < start || (!forward && pos === at && pos === start)) return -1;
        const next = this.next(text, pos);
        if (text.startsWith(glyph, pos) && (scalar || pos + glyph.length === next) && !(repeat && till && n === 0 && (forward ? this.prev(text, pos) : next) === at)) break;
        if (!forward && pos === start) return -1;
      }
    }
    return till ? forward ? this.prev(text, pos) : this.next(text, pos) : pos;
  }
  /** @param {string} text @param {number} at @param {boolean} forward @param {number} count */
  paragraph(text, at, forward, count) {
    let pos = lineStart(text, at);
    for (let n = 0; n < count; n++) {
      const wasEmpty = this.empty(text, pos);
      let sawText = !wasEmpty;
      for (;;) {
        if (forward) {
          const next = afterLine(text, lineEnd(text, pos));
          if (next === pos || next === text.length) return text.length;
          pos = next;
        } else {
          if (pos === 0) return 0;
          pos = lineStart(text, pos - 1);
        }
        if (this.empty(text, pos)) { if (sawText) break; }
        else sawText = true;
      }
    }
    return pos;
  }
  /** @param {string} text @param {number} at */
  match(text, at) {
    const end = lineEnd(text, at);
    while (at < end && !"()[]{}".includes(text[at])) at = this.next(text, at);
    if (at === end) return -1;
    const open = "([{", close = ")]}", ch = text[at], forward = open.includes(ch);
    const mate = forward ? close[open.indexOf(ch)] : open[close.indexOf(ch)];
    // Delimiters inside quoted strings do not participate in a pair.
    const pairs = this.pairs(text, forward ? ch : mate, forward ? mate : ch);
    for (let i = 0; i < pairs.length; i += 2) {
      if (pairs[i] === at) return pairs[i + 1];
      if (pairs[i + 1] === at) return pairs[i];
    }
    return -1;
  }
  /** @param {string} text @param {string} open @param {string} close @returns {number[]} */
  pairs(text, open, close) {
    const stack = /** @type {number[]} */ ([]), pairs = /** @type {number[]} */ ([]);
    let quote = "";
    for (let at = 0; at < text.length; at = this.next(text, at)) {
      const ch = text[at];
      if (ch === "\n") { quote = ""; continue; }
      if (this.escaped(text, at)) continue;
      if (quote) { if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "`" || (ch === "'" && !(at > 0 && this.cls(text, this.prev(text, at)) >= 2 && this.cls(text, this.next(text, at)) >= 2))) { quote = ch; continue; }
      if (ch === open) stack.push(at);
      else if (ch === close && stack.length) pairs.push(/** @type {number} */ (stack.pop()), at);
    }
    return pairs;
  }
  /** @param {string} text @param {number} at */
  escaped(text, at) {
    let n = 0;
    while (at > 0 && text.charCodeAt(--at) === 92) n++;
    return (n & 1) !== 0;
  }
  /** @param {string} text @param {number} at @param {string} kind @param {boolean} around @param {number} count @returns {Range | null} */
  object(text, at, kind, around, count) {
    if (kind === "w" || kind === "W") return this.wordObject(text, at, around, count, kind === "W");
    if ('"\'`'.includes(kind)) {
      const start = lineStart(text, at), end = lineEnd(text, at), quotes = /** @type {number[]} */ ([]);
      for (let i = start; i < end; i = this.next(text, i)) if (text[i] === kind && !this.escaped(text, i)) quotes.push(i);
      for (let i = 0; i + 1 < quotes.length; i += 2) {
        if (quotes[i + 1] < at) continue;
        let from = quotes[i], to = quotes[i + 1] + 1;
        if (!around && count === 1) { from++; to--; }
        else if (around) {
          const before = to;
          while (to < end && (text[to] === " " || text[to] === "\t")) to++;
          if (to === before) while (from > start && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
        }
        return { from, to, target: from, lines: false, inclusive: false };
      }
      return null;
    }
    const index = "([{bB)]}".indexOf(kind);
    if (index < 0) return null;
    const slot = kind === "b" ? 0 : kind === "B" ? 2 : "([{)]}".indexOf(kind) % 3;
    const found = this.pairs(text, "([{"[slot], ")]}"[slot]);
    let from = -1, to = -1;
    for (let n = 0; n < count; n++) {
      let best = -1, width = Infinity;
      for (let i = 0; i < found.length; i += 2) {
        const lo = found[i], hi = found[i + 1];
        if (lo <= at && hi >= at && (n === 0 || lo < from && hi > to) && hi - lo < width) { best = i; width = hi - lo; }
      }
      if (best < 0) {
        if (n !== 0) return null;
        for (let i = 0; i < found.length; i += 2) if (found[i] >= at && (best < 0 || found[i] < found[best])) best = i;
        if (best < 0) return null;
      }
      from = found[best]; to = found[best + 1];
    }
    if (around) to++;
    else {
      from++;
      if (text[from] === "\n" || text.slice(from, from + 2) === "\r\n") from = afterLine(text, from);
      const lastStart = lineStart(text, to);
      if (lastStart > from && !text.slice(lastStart, to).trim()) to = this.prev(text, lastStart);
    }
    return { from, to, target: from, lines: false, inclusive: false };
  }
  /** @param {string} text @param {number} at @param {boolean} around @param {number} count @param {boolean} big @returns {Range | null} */
  wordObject(text, at, around, count, big) {
    let from = at;
    const start = lineStart(text, at), cls = this.cls(text, at, big);
    while (from > start && this.cls(text, this.prev(text, from), big) === cls) from = this.prev(text, from);
    let pos = from, inclusive = true;
    const includeWhite = around && cls !== 0;
    if ((cls === 0) === around) {
      pos = this.objectEnd(text, pos, big);
      if (pos < 0) return null;
    } else {
      pos = this.wordStart(text, pos, 1, big, true);
      pos = this.prev(text, pos);
    }
    for (let n = 1; n < count; n++) {
      // An object step skips the nonempty line's end marker, like Vim's incl().
      let next = this.next(text, pos);
      if (next === lineEnd(text, pos) && next < text.length) next = afterLine(text, next);
      if (next >= text.length) { this.failureTarget = clamp(text, text.length); return null; }
      pos = next;
      inclusive = true;
      if (around !== (this.cls(text, pos, big) === 0)) {
        const moved = this.wordStart(text, pos, 1, big, true);
        if (moved === text.length && n + 1 < count) { this.failureTarget = clamp(text, text.length); return null; }
        if (lineStart(text, moved) === moved) { pos = moved; inclusive = false; }
        else pos = this.prev(text, moved);
      } else {
        pos = this.objectEnd(text, pos, big);
        if (pos < 0) return null;
      }
    }
    if (includeWhite && (this.cls(text, pos, big) !== 0 || lineStart(text, pos) === pos && !inclusive)) {
      let before = from;
      if (before > start) {
        before = this.prev(text, before);
        const beforeClass = this.cls(text, before, big);
        while (before > start && this.cls(text, this.prev(text, before), big) === beforeClass) before = this.prev(text, before);
        if (beforeClass === 0 && before > start) from = before;
      }
    }
    const to = inclusive && pos !== lineEnd(text, pos) ? this.next(text, pos) : pos;
    return { from, to, target: from, lines: false, inclusive: false };
  }
  /** @param {string} text @param {number} at @param {boolean} big */
  objectEnd(text, at, big) {
    if (at >= text.length) { this.failureTarget = clamp(text, text.length); return -1; }
    const cls = this.cls(text, at, big);
    if (cls !== 0) {
      let next = this.next(text, at);
      while (next < text.length && this.cls(text, next, big) === cls) { at = next; next = this.next(text, at); }
      return at;
    }
    at = this.next(text, at);
    while (at < text.length && this.cls(text, at, big) === 0) {
      if (this.empty(text, at)) return at;
      at = this.next(text, at);
    }
    if (at === text.length) { this.failureTarget = clamp(text, at); return -1; }
    return this.wordEnd(text, at, 1, big, true);
  }
}
