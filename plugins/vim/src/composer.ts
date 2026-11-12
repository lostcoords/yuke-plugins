import type { PluginContext } from "yuke:plugins";
import {
  type EditorChange,
  type EditorState,
  type KeyEvent,
  strokeOf,
  TextEditor,
  type TextExtension,
  type Tui,
} from "yuke:tui";
import type { Registers } from "./registers.ts";
import { afterLine, firstNonblank, lineEnd, lineStart, type Range as MotionRange, Navigation } from "./text.ts";

type Mode = "insert" | "normal" | "visual" | "visual-line";
interface Snapshot {
  text: string;
  caret: number;
  spans: EditorState["spans"];
  marks: Map<string, number> | null;
  visual: { from: number; to: number; lines: boolean } | null;
}
interface Recipe {
  kind: string;
  motion: string;
  operator: string;
  count: number;
  glyph: string;
  register: string;
  width: number;
  lines: boolean;
  edits: (number | string)[];
}
const MAX_COUNT = 10_000;
const HISTORY_GROUPS = 100;
const HISTORY_CHARACTERS = 1024 * 1024;
const MODIFIED = /^(ctrl|alt|super)\+/;
const REGISTER_NAME = /^[a-zA-Z0-9"_-]$/;
const MARK_NAME = /^[a-z]$/;
const INSERT_KEYS = new Set(["i", "a", "I", "A", "o", "O"]);
const SIMPLE_KEYS = new Set(["x", "X", "s", "S", "D", "C", "Y", "~", "J"]);
const VERTICAL = new Set(["j", "k", "up", "down", "gj", "gk"]);
const NAMED_MOTIONS = new Set(["left", "right", "up", "down", "home", "end"]);
const REVERSE_FIND: Readonly<Record<string, string>> = { f: "F", F: "f", t: "T", T: "t" };

/** True for a key that the native editor would use to change text: deletions, line ends, and control shortcuts. */
function editsNatively({ code, modifiers }: KeyEvent): boolean {
  if (code === "backspace" || code === "delete") return true;
  return (code === "enter" || code === "character") && Object.values(modifiers).some(Boolean);
}

class ComposerState {
  mode: Mode = "insert";
  presentedMode: Mode | undefined;
  phase = "ready";
  prefix = "";
  operator = "";
  leading = 0;
  count = 0;
  register = '"';
  anchor = 0;
  visualFrom = 0;
  visualTo = 0;
  visualLines = false;
  haveVisual = false;
  findKind = "";
  findGlyph = "";
  marks: Map<string, number> | null = null;
  query = "";
  searchForward = true;
  searchWhole = false;
  readonly undo: Snapshot[] = [];
  readonly redo: Snapshot[] = [];
  base: Snapshot | null = null;
  record: Recipe | null = null;
  last: Recipe | null = null;
  insertOrigin = 0;
  expectedCaret = 0;
  insertCount = 1;
  editFrom = -1;
  editOldTo = 0;
  editNewTo = 0;
  muted = false;
  previousText = "";
  replaying = false;
  goalColumn: number | undefined;
  readonly navigation = new Navigation();
  readonly range: MotionRange = { from: 0, to: 0, target: 0, lines: false, inclusive: false };
  readonly extension: TextExtension<number, EditorChange>;
  readonly signal: AbortSignal;
  constructor(extension: TextExtension<number, EditorChange>, signal: AbortSignal) {
    this.extension = extension;
    this.signal = signal;
  }
}

export class ComposerEditor {
  readonly states = new Map<TextEditor, ComposerState>();
  readonly ctx: PluginContext;
  readonly tui: Tui;
  readonly registers: Registers;
  constructor(ctx: PluginContext, tui: Tui, registers: Registers) {
    this.ctx = ctx;
    this.tui = tui;
    this.registers = registers;
  }

  bind(editor: TextEditor, signal: AbortSignal): () => void {
    const extension = editor.extend(signal);
    const state = new ComposerState(extension, signal);
    state.previousText = editor.state.text;
    state.expectedCaret = editor.caret;
    this.states.set(editor, state);
    const handleKey = (event: KeyEvent): boolean => {
      const handled = this.onKey(editor, event);
      this.refresh(editor, state);
      return handled;
    };
    let keymapEvent: KeyEvent | undefined;
    extension.addKeyHandler((event) => {
      keymapEvent = undefined;
      const stroke = strokeOf(event);
      if (this.tui.keys.pending() !== "" && stroke !== "esc" && stroke !== "ctrl+[") {
        keymapEvent = event;
        return false;
      }
      return handleKey(event);
    }, "beforeKeymap");
    extension.addKeyHandler((event) => {
      if (event === keymapEvent) {
        keymapEvent = undefined;
        if (handleKey(event)) return true;
      }
      // The keymap had its turn: outside Insert mode, keep native editing from changing the draft.
      return state.mode !== "insert" && editsNatively(event);
    });
    extension.addChangeListener((change) => {
      if (state.muted) return;
      if (change.kind === "reset" || change.kind === "restore") {
        state.undo.length = 0;
        state.redo.length = 0;
        state.base = null;
        state.record = null;
        state.last = null;
        state.marks = null;
        state.haveVisual = false;
        state.goalColumn = undefined;
        if (state.mode.startsWith("visual")) state.mode = "normal";
        this.reset(state);
      } else if (change.kind === "selection") {
        if (state.mode === "insert" && state.base !== null) this.finish(editor, state);
      } else {
        state.previousText = change.before.text;
        if (state.mode === "insert" && state.base === null) {
          this.begin(editor, state, "insert", "i", "", 1);
          state.base = this.snapshot(editor, state, change.before);
          state.insertOrigin = change.before.selection.head;
          state.expectedCaret = change.before.selection.head;
        }
        for (const edit of change.changes) this.recordEdit(editor, state, edit.from, edit.to, edit.text.length);
        if (change.changes.some((edit) => edit.spans.some((span) => span.kind === "image"))) state.last = null;
      }
      state.previousText = editor.state.text;
      state.expectedCaret = editor.caret;
      this.refresh(editor, state);
    });
    extension.addMouseHandler(() => {
      this.cancel(editor);
      this.refresh(editor, state);
      return false;
    });
    extension.addPasteHandler(() => {
      this.reset(state);
      return state.mode !== "insert";
    });
    this.refresh(editor, state);
    return () => {
      this.states.delete(editor);
      extension.dispose();
      this.updateStatus();
    };
  }

  refresh(editor: TextEditor, state: ComposerState): void {
    const modeChanged = state.presentedMode !== state.mode;
    if (modeChanged) {
      state.presentedMode = state.mode;
      state.extension.setContexts([`vim-${state.mode}`]);
      state.extension.setAppearance({ cursorShape: state.mode === "insert" ? "bar" : "block" });
    }
    if (state.mode.startsWith("visual")) {
      const range = { ...this.visual(editor, state) };
      this.normalize(editor, state, range);
      state.extension.setDecorations([
        {
          range: { anchor: range.from, head: range.to },
          style: { reverse: true },
          wholeRows: state.mode === "visual-line",
        },
      ]);
    } else if (modeChanged) state.extension.setDecorations([]);
    this.updateStatus();
  }

  updateStatus(): void {
    if (this.ctx.signal.aborted) return;
    const focused = this.tui.focused;
    const state = focused instanceof TextEditor ? this.states.get(focused) : undefined;
    if (state === undefined) this.tui.status.delete("mode");
    else
      this.tui.status.set("mode", {
        text: state.mode.replace("-", " ").toUpperCase(),
        side: "left",
        order: 0,
        priority: 50,
      });
  }

  insertText(editor: TextEditor, text: string): void {
    const selection = editor.selection;
    editor.replace(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head), text);
  }

  recordEdit(editor: TextEditor, state: ComposerState, from: number, to: number, length: number) {
    if (state.mode === "insert") {
      if (state.base && from !== state.expectedCaret && to !== state.expectedCaret) {
        this.finish(editor, state, state.previousText);
      }
      if (!state.base) this.beginAfter(editor, state, from);
      if (state.record && !state.replaying) {
        if (!state.record.edits.length && from >= state.editFrom && to <= state.editNewTo && state.editFrom >= 0)
          state.editNewTo += length - (to - from);
        else this.recordOutside(state.previousText, state, from, to, editor.state.text.slice(from, from + length));
      }
    }
    if (state.marks || state.haveVisual)
      this.shiftMarks(state, state.previousText, from, to, editor.state.text.slice(from, from + length));
  }

  beginAfter(editor: TextEditor, state: ComposerState, from: number) {
    this.begin(editor, state, "insert", "i", "", 1);
    if (state.base) {
      state.base.text = state.previousText;
      state.base.caret = from;
    }
    state.insertOrigin = from;
  }

  recordOutside(previousText: string, state: ComposerState, from: number, to: number, value: string) {
    const recipe = state.record;
    if (!recipe) return;
    if (recipe.edits.length) {
      recipe.edits.push(from - state.insertOrigin, to - from, value);
      return;
    }
    if (state.editFrom < 0) {
      state.editFrom = from;
      state.editOldTo = to;
      state.editNewTo = from + value.length;
      return;
    }
    if (from > state.editNewTo || to < state.editFrom) {
      recipe.edits.push(
        state.editFrom - state.insertOrigin,
        state.editOldTo - state.editFrom,
        previousText.slice(state.editFrom, state.editNewTo),
        from - state.insertOrigin,
        to - from,
        value,
      );
      return;
    }
    const delta = state.editNewTo - state.editOldTo;
    const originalFrom = from < state.editFrom ? from : from > state.editNewTo ? from - delta : state.editFrom;
    const originalTo = to < state.editFrom ? to : to > state.editNewTo ? to - delta : state.editOldTo;
    state.editFrom = Math.min(state.editFrom, originalFrom);
    state.editOldTo = Math.max(state.editOldTo, originalTo);
    state.editNewTo = state.editOldTo + delta + value.length - (to - from);
  }

  deleteInsertWord(editor: TextEditor) {
    const state = this.states.get(editor);
    if (state === undefined) return;
    const text = editor.state.text,
      to = editor.caret,
      start = lineStart(text, to);
    if (to === 0) return;
    let from = state.navigation.previous(text, to);
    if (to > start) {
      while (from > start && state.navigation.wordClass(text, from) === 0) from = state.navigation.previous(text, from);
      const wordClass = state.navigation.wordClass(text, from);
      while (from > start && state.navigation.wordClass(text, state.navigation.previous(text, from)) === wordClass)
        from = state.navigation.previous(text, from);
    }
    editor.replace(from, to, "");
    this.reset(state);
  }

  mode(editor: TextEditor | null) {
    return editor ? this.states.get(editor)?.mode || "insert" : "";
  }

  reset(state: ComposerState) {
    state.phase = "ready";
    state.prefix = "";
    state.operator = "";
    state.leading = 0;
    state.count = 0;
    state.register = '"';
  }

  cancel(editor: TextEditor) {
    const state = this.states.get(editor);
    if (!state) return;
    if (state.mode.startsWith("visual")) {
      this.rememberVisual(editor, state);
      state.mode = "normal";
    }
    if (state.mode === "insert") this.finish(editor, state);
    this.reset(state);
  }

  snapshot(editor: TextEditor, state: ComposerState, source: EditorState = editor.state): Snapshot {
    const visual = state.mode.startsWith("visual");
    return {
      text: source.text,
      caret: source.selection.head,
      spans: source.spans,
      marks: state.marks ? new Map(state.marks) : null,
      visual: visual
        ? { from: state.anchor, to: source.selection.head, lines: state.mode === "visual-line" }
        : state.haveVisual
          ? { from: state.visualFrom, to: state.visualTo, lines: state.visualLines }
          : null,
    };
  }

  push(history: Snapshot[], value: Snapshot) {
    history.push(value);
    let characters = 0;
    for (let index = history.length - 1; index >= 0; index--) {
      characters += (history[index] as Snapshot).text.length;
      if (history.length - index > HISTORY_GROUPS || (characters > HISTORY_CHARACTERS && index < history.length - 1)) {
        history.splice(0, index + 1);
        break;
      }
    }
  }

  begin(
    editor: TextEditor,
    state: ComposerState,
    kind: string,
    motion: string,
    operator: string,
    count: number,
    glyph: string = "",
  ) {
    this.finish(editor, state);
    state.base = this.snapshot(editor, state);
    state.record = {
      kind,
      motion,
      operator,
      count,
      glyph,
      register: state.register,
      width: 0,
      lines: false,
      edits: [],
    };
    state.insertOrigin = editor.caret;
    state.expectedCaret = editor.caret;
    state.editFrom = -1;
  }

  captureInsert(editor: TextEditor, state: ComposerState, text: string = editor.state.text) {
    if (state.record && !state.record.edits.length && state.editFrom >= 0)
      state.record.edits.push(
        state.editFrom - state.insertOrigin,
        state.editOldTo - state.editFrom,
        text.slice(state.editFrom, state.editNewTo),
      );
  }

  finish(editor: TextEditor, state: ComposerState, text: string = editor.state.text) {
    if (!state.base) return;
    this.captureInsert(editor, state, text);
    if (state.base.text !== text || JSON.stringify(state.base.spans) !== JSON.stringify(editor.state.spans)) {
      this.push(state.undo, state.base);
      state.redo.length = 0;
      if (!state.replaying)
        state.last =
          state.record?.edits.length && editor.state.spans.some((span) => span.kind === "image") ? null : state.record;
    }
    state.base = null;
    state.record = null;
    state.editFrom = -1;
  }

  finishInsert(editor: TextEditor, state: ComposerState, leaveInsert: boolean) {
    this.captureInsert(editor, state);
    if (leaveInsert && state.record && state.insertCount > 1 && state.record.edits.length) {
      const recipe = state.record;
      state.replaying = true;
      for (let index = 1; index < state.insertCount; index++) {
        if (recipe.motion === "o" || recipe.motion === "O") this.insertText(editor, "\n");
        this.replayInsert(editor, state, recipe);
      }
      state.replaying = false;
    }
    this.finish(editor, state);
    if (leaveInsert && editor.caret > lineStart(editor.state.text, editor.caret))
      editor.caret = state.navigation.previous(editor.state.text, editor.caret);
    state.insertCount = 1;
  }

  restore(editor: TextEditor, state: ComposerState, value: Snapshot): void {
    state.muted = true;
    try {
      const caret = state.navigation.clamp(value.text, value.caret);
      editor.restore({ text: value.text, spans: value.spans, selection: { anchor: caret, head: caret } });
      state.marks = value.marks ? new Map(value.marks) : null;
      if (value.visual !== null) {
        state.visualFrom = value.visual.from;
        state.visualTo = value.visual.to;
        state.visualLines = value.visual.lines;
        state.haveVisual = true;
      }
    } finally {
      state.muted = false;
    }
  }
  history(editor: TextEditor, state: ComposerState, redo: boolean, count: number) {
    this.finish(editor, state);
    const from = redo ? state.redo : state.undo,
      to = redo ? state.undo : state.redo;
    for (let step = 0; step < count && from.length; step++) {
      const own = from.pop() as Snapshot;
      const current = this.snapshot(editor, state);
      current.caret = own.caret;
      this.push(to, current);
      this.restore(editor, state, own);
    }
  }

  shiftMarks(state: ComposerState, text: string, from: number, to: number, value: string) {
    const delta = value.length - (to - from),
      start = lineStart(text, from),
      end = lineEnd(text, from);
    const shift = (at: number): number => {
      if (lineStart(text, at) === start && to <= end && !value.includes("\n")) return Math.min(at, end + delta);
      if (at >= to) return at + delta;
      return at >= from ? from : at;
    };
    state.marks?.forEach((at, name) => {
      const row = lineStart(text, at);
      if (!value && row >= from && lineEnd(text, row) < to) state.marks?.delete(name);
      else state.marks?.set(name, shift(at));
    });
    if (state.haveVisual) {
      state.visualFrom = shift(state.visualFrom);
      state.visualTo = shift(state.visualTo);
    }
  }

  lines(editor: TextEditor, state: ComposerState, count: number) {
    const text = editor.state.text,
      range = state.range;
    range.from = lineStart(text, editor.caret);
    range.to = range.from;
    for (let step = 0; step < count; step++) {
      const end = lineEnd(text, range.to),
        next = afterLine(text, end);
      range.to = end;
      if (next === text.length || step + 1 === count) break;
      range.to = next;
    }
    range.target = range.from;
    range.lines = true;
    range.inclusive = false;
    return range;
  }

  motion(
    editor: TextEditor,
    state: ComposerState,
    motion: string,
    count: number,
    glyph: string = "",
    counted: boolean = false,
  ) {
    const text = editor.state.text,
      at = editor.caret,
      navigation = state.navigation,
      range = state.range;
    let target = at,
      inclusive = false,
      lines = false;
    switch (motion) {
      case "h":
      case "left":
        for (let step = 0, start = lineStart(text, at); step < count && target > start; step++)
          target = navigation.previous(text, target);
        break;
      case "l":
      case "right":
      case " ":
        for (let step = 0, end = lineEnd(text, at); step < count && target < end; step++)
          target = navigation.next(text, target);
        break;
      case "0":
      case "home":
        target = lineStart(text, at);
        break;
      case "^":
        target = firstNonblank(text, at);
        break;
      case "$":
      case "end":
        for (let step = 1; step < count; step++) {
          const next = afterLine(text, lineEnd(text, target));
          if (next === text.length) break;
          target = next;
        }
        target = lineEnd(text, target);
        if (target > lineStart(text, target)) target = navigation.previous(text, target);
        inclusive = true;
        break;
      case "j":
      case "k":
      case "up":
      case "down":
      case "gj":
      case "gk": {
        const coordinates = motion === "gj" || motion === "gk" ? editor.rows : editor.lines;
        const point = coordinates.point(at);
        if (point === undefined) return null;
        const goal = state.goalColumn ?? point.column;
        const direction = motion === "j" || motion === "down" || motion === "gj" ? 1 : -1;
        const row = Math.max(0, Math.min(coordinates.count - 1, point.row + direction * count));
        target = coordinates.at({ column: goal, row }) ?? at;
        state.goalColumn = goal;
        lines = coordinates === editor.lines;
        break;
      }
      case "gg":
      case "G": {
        let row = 0;
        if (motion === "G" && !counted) row = lineStart(text, text.length);
        else
          for (let step = 1; step < count; step++) {
            const next = afterLine(text, lineEnd(text, row));
            if (next === row) break;
            row = next;
          }
        target = firstNonblank(text, row);
        lines = true;
        break;
      }
      case "w":
      case "W":
        if (state.operator === "c" && navigation.wordClass(text, at) !== 0) {
          target = navigation.wordEnd(text, at, count, motion === "W", true);
          inclusive = true;
        } else target = navigation.wordStart(text, at, count, motion === "W", !!state.operator);
        break;
      case "b":
      case "B":
        target = navigation.wordBack(text, at, count, motion === "B");
        break;
      case "e":
      case "E":
        target = navigation.wordEnd(text, at, count, motion === "E");
        inclusive = true;
        break;
      case "ge":
      case "gE":
        target = navigation.previousEnd(text, at, count, motion === "gE");
        if (target < 0) return null;
        inclusive = true;
        break;
      case "f":
      case "F":
      case "t":
      case "T":
        target = navigation.find(text, at, motion, glyph, count);
        if (target < 0) return null;
        state.findKind = motion;
        state.findGlyph = glyph;
        inclusive = motion === "f" || motion === "t";
        break;
      case ";":
      case ",": {
        if (!state.findKind) return null;
        const kind = motion === ";" ? state.findKind : REVERSE_FIND[state.findKind];
        if (!kind) return null;
        target = navigation.find(text, at, kind, state.findGlyph, count, true);
        if (target < 0) return null;
        inclusive = kind === "f" || kind === "t";
        break;
      }
      case "%":
        if (counted) {
          if (count > 100) return null;
          let total = 1;
          for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) total++;
          const wanted = Math.ceil((count * total) / 100);
          let row = 0;
          for (let step = 1; step < wanted; step++) row = afterLine(text, lineEnd(text, row));
          target = firstNonblank(text, row);
          lines = true;
        } else {
          target = navigation.match(text, at);
          if (target < 0) return null;
          inclusive = true;
        }
        break;
      case "{":
      case "}":
        target = navigation.paragraph(text, at, motion === "}", count);
        break;
      case "'":
      case "`": {
        const mark = state.marks?.get(glyph);
        if (mark == null) return null;
        target = motion === "'" ? firstNonblank(text, mark) : state.navigation.snap(text, mark);
        lines = motion === "'";
        break;
      }
      case "n":
      case "N":
        target = this.search(text, at, state, motion === "n" ? state.searchForward : !state.searchForward, count);
        if (target < 0) return null;
        break;
      case "*":
      case "#":
      case "g*":
      case "g#": {
        let position = at,
          end = lineEnd(text, at);
        while (position < end && navigation.wordClass(text, position) < 2) position = navigation.next(text, position);
        if (position === end) return null;
        const object = navigation.wordObject(text, position, false, 1, false);
        if (!object) return null;
        state.query = text.slice(object.from, object.to);
        state.searchForward = motion.includes("*");
        state.searchWhole = motion.length === 1;
        target = this.search(text, at, state, state.searchForward, count);
        if (target < 0) return null;
        break;
      }
      default:
        if (motion.length === 2 && (motion[0] === "i" || motion[0] === "a"))
          return navigation.object(text, at, motion[1] as string, motion[0] === "a", count);
        return null;
    }
    range.from = Math.min(at, target);
    range.to = Math.max(at, target);
    range.target = target;
    range.lines = lines;
    range.inclusive = inclusive;
    return range;
  }

  search(text: string, at: number, state: ComposerState, forward: boolean, count: number) {
    if (!state.query) return -1;
    for (let step = 0; step < count; step++) {
      let position = at,
        remaining = text.length + 1;
      for (;;) {
        position = forward
          ? text.indexOf(state.query, position + 1)
          : position > 0
            ? text.lastIndexOf(state.query, position - 1)
            : -1;
        if (position < 0) position = forward ? text.indexOf(state.query) : text.lastIndexOf(state.query);
        if (position < 0 || --remaining < 0) return -1;
        const end = position + state.query.length;
        if (
          state.navigation.snap(text, position) === position &&
          state.navigation.snap(text, end) === end &&
          (!state.searchWhole ||
            ((position === 0 || state.navigation.wordClass(text, state.navigation.previous(text, position)) < 2) &&
              (end === text.length || state.navigation.wordClass(text, end) < 2)))
        )
          break;
      }
      at = position;
    }
    return at;
  }

  normalize(editor: TextEditor, state: ComposerState, range: MotionRange, exact: boolean = false) {
    const text = editor.state.text;
    if (range.lines) {
      range.from = lineStart(text, range.from);
      range.to = afterLine(text, lineEnd(text, range.to));
    } else if (range.inclusive) {
      if (!state.navigation.empty(text, range.to)) range.to = state.navigation.next(text, range.to);
    } else if (
      !exact &&
      range.to > range.from &&
      lineStart(text, range.to) === range.to &&
      lineStart(text, range.from) !== range.to &&
      range.to <= text.length
    ) {
      if (range.from <= firstNonblank(text, range.from)) {
        range.from = lineStart(text, range.from);
        range.lines = true;
      } else range.to = state.navigation.previous(text, range.to);
    }
  }

  operate(
    editor: TextEditor,
    state: ComposerState,
    range: MotionRange,
    operator: string,
    units: number = 1,
    exact: boolean = false,
  ) {
    this.normalize(editor, state, range, exact);
    let from = range.from,
      to = range.to;
    const text = editor.state.text;
    if (
      operator === "d" &&
      !range.lines &&
      lineStart(text, from) !== lineStart(text, to) &&
      !text.slice(lineStart(text, from), from).trim() &&
      !text.slice(to, lineEnd(text, to)).trim()
    ) {
      range.lines = true;
      from = lineStart(text, from);
      to = afterLine(text, lineEnd(text, to));
    }
    if (operator === ">" || operator === "<") {
      from = lineStart(text, from);
      to = lineEnd(text, to > from ? state.navigation.previous(text, to) : to);
    }
    let value = text.slice(from, to);
    if (operator === "y" || operator === "d" || operator === "c") {
      if (range.lines && value.endsWith("\n")) value = value.slice(0, value.endsWith("\r\n") ? -2 : -1);
      this.registers.save(value, range.lines, operator, state.register);
    }
    if (operator === "y") {
      editor.caret = state.navigation.clamp(text, from);
      if (state.register !== "_") this.tui.clipboard.writeText(value);
      return;
    }
    if (operator === "d" || operator === "c") {
      if (range.lines && operator === "d" && to === text.length && from > 0 && !text.endsWith("\n"))
        from = state.navigation.previous(text, from);
      if (range.lines && operator === "c") {
        const last = to > from ? state.navigation.previous(text, to) : to;
        to = lineEnd(text, last);
        from = range.from;
      }
      editor.replace(from, to, "");
      editor.caret = state.navigation.snap(editor.state.text, from);
      if (operator === "c") {
        state.mode = "insert";
        state.insertOrigin = editor.caret;
      } else
        editor.caret = state.navigation.clamp(
          editor.state.text,
          range.lines ? firstNonblank(editor.state.text, editor.caret) : editor.caret,
        );
    } else {
      let replacement = value;
      if (operator === "gu") replacement = value.toLowerCase();
      else if (operator === "gU") replacement = value.toUpperCase();
      else if (operator === "g~") replacement = this.toggle(value, state.navigation);
      else replacement = this.shift(value, operator === ">", units);
      editor.replace(from, to, replacement);
      editor.caret = state.navigation.clamp(editor.state.text, state.navigation.snap(editor.state.text, from));
      if (operator === ">" || operator === "<")
        editor.caret = state.navigation.clamp(editor.state.text, firstNonblank(editor.state.text, from));
    }
    state.goalColumn = undefined;
  }

  toggle(value: string, navigation: Navigation) {
    let result = "";
    for (let at = 0; at < value.length; ) {
      const next = navigation.next(value, at),
        glyph = value.slice(at, next),
        lower = glyph.toLowerCase();
      result += glyph === lower ? glyph.toUpperCase() : lower;
      at = next;
    }
    return result;
  }

  shift(value: string, right: boolean, count: number) {
    const rows = value.split("\n");
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] as string;
      if (!row.length) continue;
      let at = 0,
        column = 0;
      while (at < row.length && (row[at] === " " || row[at] === "\t")) {
        column += row[at] === "\t" ? 2 - (column % 2) : 1;
        at++;
      }
      rows[index] = " ".repeat(right ? column + count * 2 : Math.max(0, column - count * 2)) + row.slice(at);
    }
    return rows.join("\n");
  }

  visual(editor: TextEditor, state: ComposerState) {
    const range = state.range;
    range.from = Math.min(state.anchor, editor.caret);
    range.to = Math.max(state.anchor, editor.caret);
    range.target = range.from;
    range.lines = state.mode === "visual-line";
    range.inclusive = true;
    return range;
  }

  rememberVisual(editor: TextEditor, state: ComposerState) {
    state.visualFrom = state.anchor;
    state.visualTo = editor.caret;
    state.visualLines = state.mode === "visual-line";
    state.haveVisual = true;
  }

  complete(
    editor: TextEditor,
    state: ComposerState,
    motion: string,
    count: number,
    glyph: string = "",
    counted: boolean = false,
  ) {
    state.navigation.failureTarget = -1;
    const operator = state.operator,
      range =
        motion === "line"
          ? this.lines(editor, state, count)
          : this.motion(editor, state, motion, count, glyph, counted);
    if (!range) {
      if (state.navigation.failureTarget >= 0) editor.caret = state.navigation.failureTarget;
      this.reset(state);
      return;
    }
    if (operator) {
      if (operator !== "y") this.begin(editor, state, "operator", motion, operator, count, glyph);
      this.operate(editor, state, range, operator, 1, motion.length === 2 && (motion[0] === "i" || motion[0] === "a"));
      if (this.mode(editor) !== "insert") this.finish(editor, state);
    } else {
      if (state.mode.startsWith("visual") && motion.length === 2 && (motion[0] === "i" || motion[0] === "a")) {
        state.anchor = range.from;
        editor.caret = state.navigation.previous(editor.state.text, range.to);
        state.mode = "visual";
      } else editor.caret = state.navigation.clamp(editor.state.text, range.target);
      if (!VERTICAL.has(motion)) state.goalColumn = undefined;
    }
    this.reset(state);
  }

  insert(editor: TextEditor, state: ComposerState, key: string, count: number) {
    this.begin(editor, state, "insert", key, "", count);
    const end = lineEnd(editor.state.text, editor.caret);
    if (key === "a") editor.caret = Math.min(end, state.navigation.next(editor.state.text, editor.caret));
    else if (key === "I") editor.caret = firstNonblank(editor.state.text, editor.caret);
    else if (key === "A") editor.caret = end;
    else if (key === "o" || key === "O") {
      const at = key === "o" ? end : lineStart(editor.state.text, editor.caret);
      editor.replace(at, at, "\n");
      editor.caret = at + (key === "o" ? 1 : 0);
    }
    state.insertOrigin = editor.caret;
    state.expectedCaret = editor.caret;
    state.insertCount = count;
    state.mode = "insert";
    this.reset(state);
    this.refresh(editor, state);
  }

  replayInsert(editor: TextEditor, state: ComposerState, recipe: Recipe) {
    const origin = editor.caret;
    for (let index = 0; index < recipe.edits.length; index += 3) {
      const from = state.navigation.snap(
        editor.state.text,
        Math.max(0, Math.min(editor.state.text.length, origin + (recipe.edits[index] as number))),
      );
      const to = state.navigation.snap(
        editor.state.text,
        Math.min(editor.state.text.length, from + (recipe.edits[index + 1] as number)),
      );
      const value = recipe.edits[index + 2] as string;
      editor.replace(from, to, value);
    }
  }

  put(editor: TextEditor, state: ComposerState, key: string, count: number) {
    const entry = this.registers.read(state.register);
    if (!entry || (!entry.text && !entry.linewise)) return;
    const storedText = entry.text,
      storedLines = entry.linewise;
    this.begin(editor, state, "put", key, "", count);
    const after = key === "p";
    if (state.mode.startsWith("visual")) {
      const range = this.visual(editor, state);
      this.normalize(editor, state, range);
      const from = range.from,
        to = range.to,
        lines = range.lines;
      const value = storedLines
        ? (lines ? "" : "\n") +
          Array(count).fill(storedText).join("\n") +
          (lines && editor.state.text[to - 1] !== "\n" ? "" : "\n")
        : storedText.repeat(count) + (lines && editor.state.text[to - 1] === "\n" ? "\n" : "");
      const old = editor.state.text.slice(from, to);
      if (state.record) {
        state.record.kind = "visual-put";
        state.record.width = lines
          ? editor.state.text.slice(from, to).split("\n").length - (editor.state.text[to - 1] === "\n" ? 1 : 0)
          : state.navigation.distance(editor.state.text, from, to);
        state.record.lines = lines;
      }
      this.rememberVisual(editor, state);
      if (key === "p") this.registers.save(lines && old.endsWith("\n") ? old.slice(0, -1) : old, lines, "d");
      editor.replace(from, to, value);
      editor.caret = state.navigation.clamp(
        editor.state.text,
        state.navigation.snap(
          editor.state.text,
          storedLines || lines
            ? firstNonblank(editor.state.text, from + (lines ? 0 : 1))
            : value.includes("\n")
              ? from
              : state.navigation.previous(editor.state.text, from + value.length),
        ),
      );
      state.mode = "normal";
    } else if (storedLines) {
      const at = after ? lineEnd(editor.state.text, editor.caret) : lineStart(editor.state.text, editor.caret);
      const body = Array(count).fill(storedText).join("\n");
      editor.replace(at, at, after ? `\n${body}` : `${body}\n`);
      editor.caret = state.navigation.clamp(editor.state.text, firstNonblank(editor.state.text, at + (after ? 1 : 0)));
    } else {
      const at = after
        ? Math.min(lineEnd(editor.state.text, editor.caret), state.navigation.next(editor.state.text, editor.caret))
        : editor.caret;
      const value = storedText.repeat(count);
      editor.replace(at, at, value);
      editor.caret = state.navigation.clamp(
        editor.state.text,
        value.includes("\n")
          ? at
          : state.navigation.previous(editor.state.text, state.navigation.snap(editor.state.text, at + value.length)),
      );
    }
    this.finish(editor, state);
    this.reset(state);
  }

  replace(editor: TextEditor, state: ComposerState, glyph: string, count: number) {
    let from = editor.caret,
      to = from;
    const visual = state.mode.startsWith("visual");
    if (visual) {
      const range = this.visual(editor, state);
      this.normalize(editor, state, range);
      from = range.from;
      to = range.to;
    } else {
      const end = lineEnd(editor.state.text, from);
      for (let step = 0; step < count; step++) {
        if (to >= end) return;
        to = state.navigation.next(editor.state.text, to);
      }
    }
    this.begin(editor, state, "replace", "r", "", count, glyph);
    if (visual) {
      this.rememberVisual(editor, state);
      state.mode = "normal";
    }
    let value = "";
    if (visual)
      for (let at = from; at < to; at = state.navigation.next(editor.state.text, at))
        value += editor.state.text[at] === "\n" ? "\n" : glyph;
    else value = glyph === "\n" ? glyph : glyph.repeat(count);
    editor.replace(from, to, value);
    editor.caret = state.navigation.clamp(
      editor.state.text,
      state.navigation.snap(
        editor.state.text,
        visual ? from : glyph === "\n" ? from + 1 : state.navigation.previous(editor.state.text, from + value.length),
      ),
    );
    this.finish(editor, state);
  }

  join(editor: TextEditor, state: ComposerState, key: string, count: number) {
    const text = editor.state.text;
    let from = lineStart(text, editor.caret),
      to = lineEnd(text, from),
      caret = to,
      value = text.slice(from, to);
    if (state.mode.startsWith("visual")) {
      const range = this.visual(editor, state);
      count = text.slice(range.from, range.to).split("\n").length;
      from = lineStart(text, range.from);
      to = lineEnd(text, from);
      value = text.slice(from, to);
      this.rememberVisual(editor, state);
      state.mode = "normal";
    }
    if (to === text.length) return;
    this.begin(editor, state, "join", key, "", count);
    for (let step = 1; step < Math.max(2, count) && to < text.length; step++) {
      const start = afterLine(text, to),
        end = lineEnd(text, start);
      let body = text.slice(start, end);
      if (key === "J") body = body.replace(/^[ \t]+/, "");
      caret = from + value.length;
      if (key === "J" && value && body && !/[ \t]$/.test(value) && body[0] !== ")") value += " ";
      value += body;
      to = end;
    }
    editor.replace(from, to, value);
    editor.caret = state.navigation.clamp(editor.state.text, state.navigation.snap(editor.state.text, caret));
    this.finish(editor, state);
  }

  simple(editor: TextEditor, state: ComposerState, key: string, count: number) {
    if (key === "J" || key === "gJ") {
      this.join(editor, state, key, count);
      return;
    }
    if (key === "~") {
      const range = state.range;
      range.from = editor.caret;
      range.to = range.from;
      for (let step = 0, end = lineEnd(editor.state.text, range.from); step < count && range.to < end; step++)
        range.to = state.navigation.next(editor.state.text, range.to);
      range.lines = false;
      range.inclusive = false;
      const destination = range.to;
      this.begin(editor, state, "simple", key, "", count);
      this.operate(editor, state, range, "g~");
      editor.caret = state.navigation.clamp(editor.state.text, destination);
      this.finish(editor, state);
      return;
    }
    const operator = key === "s" || key === "S" || key === "C" ? "c" : key === "Y" ? "y" : "d";
    state.operator = operator;
    if (key === "S" || key === "Y") this.complete(editor, state, "line", count);
    else this.complete(editor, state, key === "D" || key === "C" ? "$" : key === "X" ? "h" : "l", count);
    if (state.last && !state.base && operator !== "y") {
      state.last.kind = "simple";
      state.last.motion = key;
    }
    if (state.record) {
      state.record.kind = "simple";
      state.record.motion = key;
    }
  }

  repeat(editor: TextEditor, state: ComposerState, count: number, counted: boolean) {
    const last = state.last;
    if (!last) return;
    const step = counted ? count : last.count;
    state.register = last.register;
    state.replaying = true;
    if (last.kind === "operator") {
      state.operator = last.operator;
      this.complete(editor, state, last.motion, step, last.glyph, true);
    } else if (last.kind === "simple") this.simple(editor, state, last.motion, step);
    else if (last.kind === "visual-put") {
      this.begin(editor, state, "visual-put", last.motion, "d", step);
      const range = last.lines ? this.lines(editor, state, last.width) : state.range;
      if (!last.lines) {
        range.from = editor.caret;
        range.to = range.from;
        for (let k = 0; k < last.width; k++) range.to = state.navigation.next(editor.state.text, range.to);
        range.target = range.from;
        range.lines = false;
        range.inclusive = false;
      }
      this.operate(editor, state, range, "d", 1, true);
      this.finish(editor, state);
    } else if (last.kind === "put") this.put(editor, state, last.motion, step);
    else if (last.kind === "replace") this.replace(editor, state, last.glyph, step);
    else if (last.kind === "join") this.join(editor, state, last.motion, step);
    else if (last.kind === "visual") {
      state.mode = last.lines ? "visual-line" : "visual";
      state.anchor = editor.caret;
      for (let k = 0; k < last.width; k++)
        editor.caret = last.lines
          ? afterLine(editor.state.text, lineEnd(editor.state.text, editor.caret))
          : state.navigation.next(editor.state.text, editor.caret);
      editor.caret = state.navigation.clamp(editor.state.text, editor.caret);
      this.visualOperate(editor, state, last.operator, step);
    } else this.insert(editor, state, last.motion, step);
    if (state.mode === "insert") {
      for (let index = 0; index < (last.kind === "insert" ? step : 1); index++) {
        if (index && (last.motion === "o" || last.motion === "O")) this.insertText(editor, "\n");
        this.replayInsert(editor, state, last);
      }
      state.insertCount = 1;
      this.finishInsert(editor, state, true);
      state.mode = "normal";
    }
    state.replaying = false;
    state.last = last;
    this.reset(state);
  }

  visualOperate(editor: TextEditor, state: ComposerState, operator: string, count: number) {
    const range = this.visual(editor, state),
      lines = range.lines,
      width = lines
        ? editor.state.text.slice(range.from, range.to).split("\n").length - 1
        : state.navigation.distance(editor.state.text, range.from, range.to);
    if (operator !== "y") this.begin(editor, state, "visual", "", operator, count);
    if (state.record) {
      state.record.width = width;
      state.record.lines = lines;
    }
    this.rememberVisual(editor, state);
    state.mode = "normal";
    this.operate(editor, state, range, operator, count);
    if (this.mode(editor) !== "insert") this.finish(editor, state);
    this.reset(state);
  }

  onKey(editor: TextEditor, event: KeyEvent) {
    const state = this.states.get(editor);
    if (state === undefined) return false;
    const normalized = strokeOf(event);
    const stroke = normalized === "space" ? " " : normalized;
    if (
      state.mode === "normal" &&
      stroke === "down" &&
      !state.count &&
      !state.leading &&
      !state.operator &&
      editor.rows.point(editor.caret)?.row === editor.rows.count - 1
    )
      return false;
    if (stroke === "esc" || stroke === "ctrl+[") {
      if (state.mode === "insert") {
        this.finishInsert(editor, state, true);
        state.mode = "normal";
        editor.caret = state.navigation.clamp(editor.state.text, editor.caret);
      } else if (state.mode.startsWith("visual")) {
        this.rememberVisual(editor, state);
        state.mode = "normal";
      }
      this.reset(state);
      this.refresh(editor, state);
      return true;
    }
    if (
      stroke === "tab" ||
      ((event.modifiers.ctrl || event.modifiers.alt || event.modifiers.super) &&
        stroke !== "ctrl+r" &&
        stroke !== "alt+/" &&
        !(state.mode === "insert" && stroke === "ctrl+w"))
    ) {
      this.reset(state);
      return false;
    }
    if (state.phase === "register" || state.phase === "insert-register") {
      const insert = state.phase === "insert-register";
      state.phase = "ready";
      if (REGISTER_NAME.test(stroke)) {
        if (insert) {
          const entry = this.registers.read(stroke);
          if (entry) this.insertText(editor, entry.text + (entry.linewise ? "\n" : ""));
        } else state.register = stroke;
      } else this.reset(state);
      return true;
    }
    if (state.mode === "insert") {
      if (stroke === "ctrl+w") {
        this.deleteInsertWord(editor);
        return true;
      }
      if (stroke === "ctrl+r") {
        state.phase = "insert-register";
        return true;
      }
      return false;
    }
    if (
      state.phase === "ready" &&
      !state.operator &&
      !state.leading &&
      !state.count &&
      (stroke === "w" || stroke === "b" || stroke === "e" || stroke === "W" || stroke === "B" || stroke === "E")
    ) {
      this.moveWord(editor, state, stroke);
      return true;
    }
    if (MODIFIED.test(stroke)) {
      if (stroke === "ctrl+r") {
        this.history(editor, state, true, state.count || state.leading || 1);
        this.reset(state);
        return true;
      }
      if (stroke === "alt+/") {
        this.openSearch(editor, state);
        return true;
      }
      this.reset(state);
      return false;
    }
    const handled = this.parse(editor, state, stroke);
    return handled;
  }

  moveWord(editor: TextEditor, state: ComposerState, stroke: string) {
    const text = editor.state.text,
      at = editor.caret;
    editor.caret = state.navigation.clamp(
      text,
      stroke === "w" || stroke === "W"
        ? state.navigation.wordStart(text, at, 1, stroke === "W")
        : stroke === "b" || stroke === "B"
          ? state.navigation.wordBack(text, at, 1, stroke === "B")
          : state.navigation.wordEnd(text, at, 1, stroke === "E"),
    );
    state.goalColumn = undefined;
  }

  parse(editor: TextEditor, state: ComposerState, stroke: string) {
    const counted = !!(state.leading || state.count),
      count = (state.leading || 1) * (state.count || 1);
    if (state.phase === "character") {
      const kind = state.prefix;
      if (stroke === "enter" && kind === "r") {
        this.replace(editor, state, "\n", count);
        this.reset(state);
        return true;
      }
      if (stroke && state.navigation.next(stroke, 0) === stroke.length) {
        if (kind === "r") this.replace(editor, state, stroke, count);
        else this.complete(editor, state, kind, count, stroke, counted);
      }
      this.reset(state);
      return true;
    }
    if (state.phase === "mark") {
      if (MARK_NAME.test(stroke)) {
        if (state.prefix === "m") {
          if (!state.marks) state.marks = new Map();
          state.marks.set(stroke, editor.caret);
        } else this.complete(editor, state, state.prefix, count, stroke, counted);
      }
      this.reset(state);
      return true;
    }
    if (state.phase === "text-object") {
      this.complete(editor, state, state.prefix + stroke, count, "", counted);
      return true;
    }
    if (state.phase === "prefix") {
      const prefix = state.prefix;
      state.phase = "ready";
      if (prefix === "g" && (stroke === "u" || stroke === "U" || stroke === "~")) {
        state.operator = `g${stroke}`;
        state.leading = counted ? count : 0;
        state.count = 0;
        state.phase = "operator";
        return true;
      }
      if (prefix === "g" && stroke === "v" && !state.operator && state.haveVisual) {
        state.mode = state.visualLines ? "visual-line" : "visual";
        state.anchor = state.navigation.snap(editor.state.text, Math.min(state.visualFrom, editor.state.text.length));
        editor.caret = state.navigation.clamp(
          editor.state.text,
          state.navigation.snap(editor.state.text, Math.min(state.visualTo, editor.state.text.length)),
        );
        this.reset(state);
        return true;
      }
      if (prefix === "g" && stroke === "J" && !state.operator) {
        this.join(editor, state, "gJ", count);
        this.reset(state);
        return true;
      }
      this.complete(editor, state, prefix + stroke, count, "", counted);
      return true;
    }
    if (stroke === "backspace") stroke = "h";
    else if (stroke === "delete") stroke = "x";
    if (stroke.length === 1 && stroke >= "0" && stroke <= "9" && (stroke !== "0" || state.count > 0)) {
      state.count = state.count * 10 + Number(stroke);
      if ((state.leading || 1) * state.count > MAX_COUNT) {
        this.reset(state);
        this.ctx.notify("warn", "Vim count exceeds 10000");
      }
      return true;
    }
    if (stroke === '"') {
      state.phase = "register";
      return true;
    }
    if (stroke === "g") {
      state.prefix = "g";
      state.phase = "prefix";
      return true;
    }
    if (stroke === "f" || stroke === "F" || stroke === "t" || stroke === "T" || (stroke === "r" && !state.operator)) {
      state.prefix = stroke;
      state.phase = "character";
      return true;
    }
    if ((stroke === "m" && !state.operator) || stroke === "'" || stroke === "`") {
      state.prefix = stroke;
      state.phase = "mark";
      return true;
    }
    if (state.operator) {
      if (stroke === "i" || stroke === "a") {
        state.prefix = stroke;
        state.phase = "text-object";
        return true;
      }
      const doubled =
        stroke === state.operator ||
        (state.operator === "gu" && stroke === "u") ||
        (state.operator === "gU" && stroke === "U") ||
        (state.operator === "g~" && stroke === "~");
      this.complete(editor, state, doubled ? "line" : stroke, count, "", counted);
      return true;
    }
    if (state.mode.startsWith("visual")) {
      if (stroke === "o") {
        const old = state.anchor;
        state.anchor = editor.caret;
        editor.caret = old;
        this.reset(state);
        return true;
      }
      if (stroke === "i" || stroke === "a") {
        state.prefix = stroke;
        state.phase = "text-object";
        return true;
      }
      if (
        stroke === "d" ||
        stroke === "x" ||
        stroke === "c" ||
        stroke === "y" ||
        stroke === "u" ||
        stroke === "U" ||
        stroke === "~" ||
        stroke === ">" ||
        stroke === "<"
      ) {
        this.visualOperate(
          editor,
          state,
          stroke === "x" ? "d" : stroke === "u" ? "gu" : stroke === "U" ? "gU" : stroke === "~" ? "g~" : stroke,
          count,
        );
        return true;
      }
    }
    if (stroke === "v" || stroke === "V") {
      const next = stroke === "v" ? "visual" : "visual-line";
      if (state.mode === next) {
        this.rememberVisual(editor, state);
        state.mode = "normal";
      } else {
        if (!state.mode.startsWith("visual")) state.anchor = editor.caret;
        state.mode = next;
      }
      this.reset(state);
      return true;
    }
    if (stroke === "d" || stroke === "c" || stroke === "y" || stroke === ">" || stroke === "<") {
      state.operator = stroke;
      state.leading = counted ? count : 0;
      state.count = 0;
      state.phase = "operator";
      return true;
    }
    if (INSERT_KEYS.has(stroke)) {
      this.insert(editor, state, stroke, count);
      return true;
    }
    if (SIMPLE_KEYS.has(stroke)) {
      this.simple(editor, state, stroke, count);
      this.reset(state);
      return true;
    }
    if (stroke === "p" || stroke === "P") {
      this.put(editor, state, stroke, count);
      return true;
    }
    if (stroke === "u") {
      this.history(editor, state, false, count);
      this.reset(state);
      return true;
    }
    if (stroke === ".") {
      this.repeat(editor, state, count, counted);
      return true;
    }
    if (stroke === "/") {
      if (state.mode.startsWith("visual")) this.rememberVisual(editor, state);
      this.insert(editor, state, "i", 1);
      this.insertText(editor, "/");
      return true;
    }
    if (stroke === "?") {
      this.openSearch(editor, state, false);
      return true;
    }
    if (stroke === "enter") {
      this.reset(state);
      return false;
    }
    if (stroke.length !== 1 && !NAMED_MOTIONS.has(stroke)) {
      this.reset(state);
      return false;
    }
    this.complete(editor, state, stroke, count, "", counted);
    // Consume unknown Vim strokes so native editing does not insert them.
    return true;
  }

  openSearch(editor: TextEditor, state: ComposerState, forward = true): void {
    const original = editor.state;
    const operator = state.operator;
    const register = state.register;
    const count = (state.leading || 1) * (state.count || 1);
    this.reset(state);
    // A draft that changed while the prompt was open takes no search.
    void this.tui.input({
      title: "Search draft (literal, case-sensitive)",
      text: state.query,
      signal: state.signal,
      onSubmit: (text) => {
        if (!this.states.has(editor) || editor.state !== original) return;
        if (text !== "") state.query = text;
        state.searchForward = forward;
        state.searchWhole = false;
        state.operator = operator;
        state.register = register;
        this.complete(editor, state, "n", count);
        this.refresh(editor, state);
      },
    });
  }
}
