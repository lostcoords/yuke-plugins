// Vim motion classes and half-open text ranges on whole graphemes.
import { graphemes } from "yuke:tui";
import { vimClass } from "./unicode-classes.ts";

const EMPTY_CELLS = new Int32Array(0);

/** A half-open operator range in UTF-16 units. */
export interface Range {
  from: number;
  to: number;
  target: number;
  lines: boolean;
  inclusive: boolean;
}

/** The start of the logical line at `at`. */
export function lineStart(text: string, at: number): number {
  return at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
}
/** The end of the logical line, before LF or CRLF. */
export function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end > 0 && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
}
/** The offset after the line ending at `end`. */
export function afterLine(text: string, end: number): number {
  return end === text.length ? end : end + (text.charCodeAt(end) === 13 ? 2 : 1);
}
/** The first character other than a space or tab on the logical line. */
export function firstNonblank(text: string, at: number): number {
  let start = lineStart(text, at);
  const end = lineEnd(text, start);
  while (start < end && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
  return start;
}
/** Vim motions and half-open operator ranges, with one cached segmentation. */
export class Navigation {
  private cachedText = "";
  private cachedGraphemes: Int32Array = EMPTY_CELLS;
  /** The partial destination of a failed word object or previous-end motion. */
  failureTarget = -1;

  private cells(text: string): Int32Array {
    if (this.cachedText === text) return this.cachedGraphemes;
    this.cachedText = text;
    this.cachedGraphemes = graphemes(text);
    return this.cachedGraphemes;
  }
  /** The normal-mode caret, before the last grapheme of a nonempty line. */
  clamp(text: string, at: number): number {
    at = Math.max(0, Math.min(at, text.length));
    const end = lineEnd(text, at);
    return at >= end && end > lineStart(text, at) ? this.previous(text, end) : at;
  }
  /** The boundary at or before `at`, after an edit joins graphemes. */
  snap(text: string, at: number): number {
    if (at <= 0) return 0;
    if (at >= text.length) return text.length;
    const left = text.charCodeAt(at - 1),
      right = text.charCodeAt(at);
    if (left < 256 && right < 256 && !(left === 13 && right === 10)) return at;
    const cells = this.cells(text);
    let before = 0;
    for (let index = 0; index < cells.length && (cells[index] as number) <= at; index += 3)
      before = cells[index] as number;
    return before;
  }
  /** The next grapheme boundary, or the end of the text. */
  next(text: string, at: number): number {
    if (at >= text.length) return text.length;
    const currentCode = text.charCodeAt(at),
      adjacentCode = text.charCodeAt(at + 1);
    if (currentCode < 256 && (at + 1 === text.length || adjacentCode < 256))
      return at + (currentCode === 13 && adjacentCode === 10 ? 2 : 1);
    return this.unicodeStep(text, at, true);
  }
  /** The previous grapheme boundary, or zero. */
  previous(text: string, at: number): number {
    if (at <= 0) return 0;
    const currentCode = text.charCodeAt(at - 1),
      adjacentCode = text.charCodeAt(at - 2);
    if (currentCode < 256 && (at === 1 || adjacentCode < 256))
      return at - (currentCode === 10 && adjacentCode === 13 ? 2 : 1);
    return this.unicodeStep(text, at, false);
  }
  private unicodeStep(text: string, at: number, forward: boolean): number {
    const cells = this.cells(text);
    let lower = 0,
      upper = cells.length / 3 - 1;
    while (lower <= upper) {
      const middle = (lower + upper) >>> 1,
        start = cells[middle * 3] as number;
      if (start < at) lower = middle + 1;
      else if (start > at) upper = middle - 1;
      else
        return forward
          ? start + (cells[middle * 3 + 1] as number)
          : middle > 0
            ? (cells[(middle - 1) * 3] as number)
            : 0;
    }
    return forward ? text.length : upper >= 0 ? (cells[upper * 3] as number) : 0;
  }
  /** The number of grapheme steps from `from` to `to`. */
  distance(text: string, from: number, to: number): number {
    let count = 0;
    while (from < to) {
      from = this.next(text, from);
      count++;
    }
    return count;
  }
  /** The Vim word class at `at`; `big` joins all nonblank classes. */
  wordClass(text: string, at: number, big = false): number {
    if (
      at >= text.length ||
      text.charCodeAt(at) === 10 ||
      (text.charCodeAt(at) === 13 && text.charCodeAt(at + 1) === 10)
    )
      return 0;
    const code = text.codePointAt(at) as number;
    const motionClass = vimClass(code);
    return big && motionClass !== 0 ? 1 : motionClass;
  }
  /** Whether `at` starts an empty logical line. */
  empty(text: string, at: number): boolean {
    return lineStart(text, at) === at && lineEnd(text, at) === at;
  }
  /** The next word start; an operator stops at the last logical line end. */
  wordStart(text: string, at: number, count = 1, big = false, operator = false): number {
    for (let iteration = 0; iteration < count && at < text.length; iteration++) {
      const motionClass = this.wordClass(text, at, big),
        end = lineEnd(text, at),
        origin = at;
      at = this.next(text, at);
      if (operator && iteration === count - 1 && at >= end) return origin === end ? at : end;
      if (motionClass !== 0) {
        while (at < text.length && this.wordClass(text, at, big) === motionClass) {
          at = this.next(text, at);
          if (operator && iteration === count - 1 && at >= end) return end;
        }
      }
      while (at < text.length && this.wordClass(text, at, big) === 0) {
        if (this.empty(text, at)) break;
        if (operator && iteration === count - 1 && at >= end) return end;
        at = this.next(text, at);
      }
    }
    return at;
  }
  /** The previous word start. */
  wordBack(text: string, at: number, count = 1, big = false): number {
    for (let iteration = 0; iteration < count && at > 0; iteration++) {
      at = this.previous(text, at);
      while (at > 0 && this.wordClass(text, at, big) === 0 && !this.empty(text, at)) at = this.previous(text, at);
      if (this.empty(text, at)) continue;
      const motionClass = this.wordClass(text, at, big);
      while (at > 0) {
        const previous = this.previous(text, at);
        if (this.wordClass(text, previous, big) !== motionClass) break;
        at = previous;
      }
    }
    return at;
  }
  /** The next word end; `stay` includes the current word. */
  wordEnd(text: string, at: number, count = 1, big = false, stay = false): number {
    for (let iteration = 0; iteration < count && at < text.length; iteration++) {
      if (!stay || iteration !== 0) at = this.next(text, at);
      while (at < text.length && this.wordClass(text, at, big) === 0) at = this.next(text, at);
      if (at === text.length) return at;
      const motionClass = this.wordClass(text, at, big);
      let following = this.next(text, at);
      while (following < text.length && this.wordClass(text, following, big) === motionClass) {
        at = following;
        following = this.next(text, at);
      }
    }
    return at;
  }
  /** The previous word end, or -1 when the motion fails. */
  previousEnd(text: string, at: number, count = 1, big = false): number {
    const partial = at > 0 && this.wordClass(text, at, big) !== 0;
    for (let iteration = 0; iteration < count; iteration++) {
      if (at <= 0) {
        this.failureTarget = 0;
        return partial ? 0 : -1;
      }
      const motionClass = this.wordClass(text, at, big);
      at = this.previous(text, at);
      if (motionClass !== 0) {
        while (this.wordClass(text, at, big) === motionClass) {
          if (at === 0) {
            this.failureTarget = 0;
            return partial ? 0 : -1;
          }
          at = this.previous(text, at);
        }
      }
      while (at > 0 && this.wordClass(text, at, big) === 0 && !this.empty(text, at)) at = this.previous(text, at);
    }
    return at;
  }
  /** The line-local f, F, t, or T destination, or -1 when no match exists. */
  find(text: string, at: number, kind: string, glyph: string, count: number, repeat = false): number {
    const forward = kind === "f" || kind === "t",
      till = kind === "t" || kind === "T";
    const start = lineStart(text, at),
      end = lineEnd(text, at);
    const scalar = glyph.length === ((glyph.codePointAt(0) as number) < 0x1_00_00 ? 1 : 2);
    let position = at;
    for (let iteration = 0; iteration < count; iteration++) {
      for (;;) {
        const before = position;
        position = forward ? this.next(text, position) : this.previous(text, position);
        if (position === before) return -1;
        if (position >= end || position < start || (!forward && position === at && position === start)) return -1;
        const following = this.next(text, position);
        if (
          text.startsWith(glyph, position) &&
          (scalar || position + glyph.length === following) &&
          !(repeat && till && iteration === 0 && (forward ? this.previous(text, position) : following) === at)
        )
          break;
        if (!forward && position === start) return -1;
      }
    }
    return till ? (forward ? this.previous(text, position) : this.next(text, position)) : position;
  }
  /** The paragraph boundary in the given direction. */
  paragraph(text: string, at: number, forward: boolean, count: number): number {
    let position = lineStart(text, at);
    for (let iteration = 0; iteration < count; iteration++) {
      const wasEmpty = this.empty(text, position);
      let sawText = !wasEmpty;
      for (;;) {
        if (forward) {
          const following = afterLine(text, lineEnd(text, position));
          if (following === position || following === text.length) return text.length;
          position = following;
        } else {
          if (position === 0) return 0;
          position = lineStart(text, position - 1);
        }
        if (this.empty(text, position)) {
          if (sawText) break;
        } else sawText = true;
      }
    }
    return position;
  }
  /** The matching bracket at or after `at` on this line, or -1. */
  match(text: string, at: number): number {
    const end = lineEnd(text, at);
    while (at < end && !"()[]{}".includes(text.charAt(at))) at = this.next(text, at);
    if (at === end) return -1;
    const open = "([{",
      close = ")]}",
      character = text.charAt(at),
      forward = open.includes(character);
    const mate = forward ? close.charAt(open.indexOf(character)) : open.charAt(close.indexOf(character));
    // Delimiters inside quoted strings do not participate in a pair.
    const pairs = this.pairs(text, forward ? character : mate, forward ? mate : character);
    for (let index = 0; index < pairs.length; index += 2) {
      if ((pairs[index] as number) === at) return pairs[index + 1] as number;
      if ((pairs[index + 1] as number) === at) return pairs[index] as number;
    }
    return -1;
  }
  private pairs(text: string, open: string, close: string): number[] {
    const stack: number[] = [],
      pairs: number[] = [];
    let quote = "";
    for (let at = 0; at < text.length; at = this.next(text, at)) {
      const character = text.charAt(at);
      if (character === "\n") {
        quote = "";
        continue;
      }
      if (this.escaped(text, at)) continue;
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (
        character === '"' ||
        character === "`" ||
        (character === "'" &&
          !(
            at > 0 &&
            this.wordClass(text, this.previous(text, at)) >= 2 &&
            this.wordClass(text, this.next(text, at)) >= 2
          ))
      ) {
        quote = character;
        continue;
      }
      if (character === open) stack.push(at);
      else if (character === close && stack.length) pairs.push(stack.pop() as number, at);
    }
    return pairs;
  }
  private escaped(text: string, at: number): boolean {
    let iteration = 0;
    while (at > 0 && text.charCodeAt(--at) === 92) iteration++;
    return (iteration & 1) !== 0;
  }
  /** The word, quote, or bracket object, or null when no object exists. */
  object(text: string, at: number, kind: string, around: boolean, count: number): Range | null {
    if (kind === "w" || kind === "W") return this.wordObject(text, at, around, count, kind === "W");
    if ("\"'`".includes(kind)) {
      const start = lineStart(text, at),
        end = lineEnd(text, at),
        quotes: number[] = [];
      for (let index = start; index < end; index = this.next(text, index))
        if (text[index] === kind && !this.escaped(text, index)) quotes.push(index);
      for (let index = 0; index + 1 < quotes.length; index += 2) {
        if ((quotes[index + 1] as number) < at) continue;
        let from = quotes[index] as number,
          to = (quotes[index + 1] as number) + 1;
        if (!around && count === 1) {
          from++;
          to--;
        } else if (around) {
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
    const found = this.pairs(text, "([{".charAt(slot), ")]}".charAt(slot));
    let from = -1,
      to = -1;
    for (let iteration = 0; iteration < count; iteration++) {
      let best = -1,
        width = Infinity;
      for (let index = 0; index < found.length; index += 2) {
        const lower = found[index] as number,
          upper = found[index + 1] as number;
        if (lower <= at && upper >= at && (iteration === 0 || (lower < from && upper > to)) && upper - lower < width) {
          best = index;
          width = upper - lower;
        }
      }
      if (best < 0) {
        if (iteration !== 0) return null;
        for (let index = 0; index < found.length; index += 2)
          if ((found[index] as number) >= at && (best < 0 || (found[index] as number) < (found[best] as number)))
            best = index;
        if (best < 0) return null;
      }
      from = found[best] as number;
      to = found[best + 1] as number;
    }
    if (around) to++;
    else {
      from++;
      if (text[from] === "\n" || text.slice(from, from + 2) === "\r\n") from = afterLine(text, from);
      const lastStart = lineStart(text, to);
      if (lastStart > from && !text.slice(lastStart, to).trim()) to = this.previous(text, lastStart);
    }
    return { from, to, target: from, lines: false, inclusive: false };
  }
  /** The inner or around word object, or null when the count exceeds the text. */
  wordObject(text: string, at: number, around: boolean, count: number, big: boolean): Range | null {
    let from = at;
    const start = lineStart(text, at),
      motionClass = this.wordClass(text, at, big);
    while (from > start && this.wordClass(text, this.previous(text, from), big) === motionClass)
      from = this.previous(text, from);
    let position = from,
      inclusive = true;
    const includeWhitespace = around && motionClass !== 0;
    if ((motionClass === 0) === around) {
      position = this.objectEnd(text, position, big);
      if (position < 0) return null;
    } else {
      position = this.wordStart(text, position, 1, big, true);
      position = this.previous(text, position);
    }
    for (let iteration = 1; iteration < count; iteration++) {
      // An object step skips the nonempty line's end marker, like Vim's incl().
      let following = this.next(text, position);
      if (following === lineEnd(text, position) && following < text.length) following = afterLine(text, following);
      if (following >= text.length) {
        this.failureTarget = this.clamp(text, text.length);
        return null;
      }
      position = following;
      inclusive = true;
      if (around !== (this.wordClass(text, position, big) === 0)) {
        const moved = this.wordStart(text, position, 1, big, true);
        if (moved === text.length && iteration + 1 < count) {
          this.failureTarget = this.clamp(text, text.length);
          return null;
        }
        if (lineStart(text, moved) === moved) {
          position = moved;
          inclusive = false;
        } else position = this.previous(text, moved);
      } else {
        position = this.objectEnd(text, position, big);
        if (position < 0) return null;
      }
    }
    if (
      includeWhitespace &&
      (this.wordClass(text, position, big) !== 0 || (lineStart(text, position) === position && !inclusive))
    ) {
      let before = from;
      if (before > start) {
        before = this.previous(text, before);
        const beforeClass = this.wordClass(text, before, big);
        while (before > start && this.wordClass(text, this.previous(text, before), big) === beforeClass)
          before = this.previous(text, before);
        if (beforeClass === 0 && before > start) from = before;
      }
    }
    const to = inclusive && position !== lineEnd(text, position) ? this.next(text, position) : position;
    return { from, to, target: from, lines: false, inclusive: false };
  }
  private objectEnd(text: string, at: number, big: boolean): number {
    if (at >= text.length) {
      this.failureTarget = this.clamp(text, text.length);
      return -1;
    }
    const motionClass = this.wordClass(text, at, big);
    if (motionClass !== 0) {
      let following = this.next(text, at);
      while (following < text.length && this.wordClass(text, following, big) === motionClass) {
        at = following;
        following = this.next(text, at);
      }
      return at;
    }
    at = this.next(text, at);
    while (at < text.length && this.wordClass(text, at, big) === 0) {
      if (this.empty(text, at)) return at;
      at = this.next(text, at);
    }
    if (at === text.length) {
      this.failureTarget = this.clamp(text, at);
      return -1;
    }
    return this.wordEnd(text, at, 1, big, true);
  }
}
