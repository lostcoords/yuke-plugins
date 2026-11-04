import type { PluginContext } from "yuke:plugins";
import type { KeyEvent, TextPosition, Tui, WidgetMount } from "yuke:tui";
import { graphemes, measure, strokeOf, TextEditor, type TextView } from "yuke:tui";
import type { Registers } from "./registers.ts";
import { firstNonblank, lineEnd, lineStart, Navigation } from "./text.ts";

/** Read-only Vim commands. Positions use the native source map and survive folds and resize. */
export class TranscriptEditor {
  private readonly nav = new Navigation();
  private text = "";
  private readonly starts: number[] = [];
  private dirty = true;
  private phase = "";
  private operator = false;
  private prefix = "";
  private count = 0;
  private leading = 0;
  private register = '"';
  private anchor: TextPosition | undefined;
  private lines = false;
  private previousVisual: { anchor: TextPosition; head: TextPosition; lines: boolean } | undefined;
  private goal: number | undefined;
  private last: TextPosition | undefined;
  private documentKey: string;
  private query = "";
  private forward = true;
  private whole = false;
  private find = "";
  private glyph = "";
  private readonly extension;

  private readonly ctx: PluginContext;
  private readonly tui: Tui;
  private readonly mount: WidgetMount;
  private readonly view: TextView;
  private readonly registers: Registers;
  private readonly marks: Map<string, Map<string, TextPosition>>;

  constructor(
    ctx: PluginContext,
    tui: Tui,
    mount: WidgetMount,
    view: TextView,
    registers: Registers,
    marks: Map<string, Map<string, TextPosition>>,
  ) {
    this.ctx = ctx;
    this.tui = tui;
    this.mount = mount;
    this.view = view;
    this.registers = registers;
    this.marks = marks;
    this.documentKey = view.document.key;
    this.extension = view.extend(mount.signal);
    this.extension.setAppearance({ cursorShape: "block" });
    this.extension.onKey((event) => this.key(event), "beforeKeymap");
    this.extension.onChange((event) => {
      if (event.kind === "document" || event.kind === "layout") this.dirty = true;
      if (view.document.key !== this.documentKey) {
        this.documentKey = view.document.key;
        this.last = undefined;
        this.anchor = undefined;
        this.previousVisual = undefined;
        this.cancel();
      }
    });
  }

  cancel(): void {
    this.phase = "";
    this.operator = false;
    this.prefix = "";
    this.count = 0;
    this.leading = 0;
    this.register = '"';
  }

  focus(): void {
    if (this.view.caret === undefined && this.last !== undefined && this.view.rows.point(this.last) !== undefined)
      this.view.caret = this.last;
    if (this.view.caret === undefined || this.view.rows.point(this.view.caret) === undefined) {
      for (let row = Math.min(this.view.rows.count - 1, this.view.visibleRows.to - 1); row >= 0; row -= 1) {
        const position = this.view.rows.at({ row, column: 0 });
        if (position !== undefined) {
          this.view.caret = position;
          break;
        }
      }
    }
    this.status();
  }

  blur(): void {
    this.last = this.view.caret;
    this.cancel();
    this.remember();
    this.anchor = undefined;
    this.lines = false;
    this.view.selection = undefined;
    this.view.caret = undefined;
  }

  private visible(position: TextPosition | undefined): boolean {
    return position !== undefined && this.view.rows.point(position) !== undefined;
  }

  private status(): void {
    this.tui.status.set("mode", {
      text: this.anchor === undefined ? "NORMAL" : this.lines ? "VISUAL LINE" : "VISUAL",
      side: "left",
      order: 0,
      priority: 50,
    });
  }

  private document(): string {
    if (!this.dirty) return this.text;
    this.dirty = false;
    const rows: string[] = [];
    this.starts.length = 0;
    let start = 0;
    for (let row = 0; row < this.view.rows.count; row += 1) {
      const value = this.view.rows.text(row);
      this.starts.push(start);
      rows.push(value);
      start += value.length + 1;
    }
    this.text = rows.join("\n");
    return this.text;
  }

  private offset(position: TextPosition): number {
    this.document();
    const point = this.view.rows.point(position, "grapheme");
    if (point === undefined) return 0;
    const row = this.view.rows.text(point.row);
    const cells = graphemes(row);
    return (this.starts[point.row] ?? 0) + (cells[point.column * 3] ?? row.length);
  }

  private position(offset: number): TextPosition | undefined {
    this.document();
    let lower = 0,
      upper = this.starts.length - 1;
    while (lower <= upper) {
      const middle = (lower + upper) >>> 1;
      if ((this.starts[middle] ?? 0) <= offset) lower = middle + 1;
      else upper = middle - 1;
    }
    const row = Math.max(0, upper);
    const text = this.view.rows.text(row);
    return this.view.rows.at({ row, column: measure(text.slice(0, Math.max(0, offset - (this.starts[row] ?? 0)))) });
  }

  private remember(): void {
    const head = this.view.caret;
    if (this.anchor !== undefined && head !== undefined)
      this.previousVisual = { anchor: this.anchor, head, lines: this.lines };
  }

  private settle(position: TextPosition): void {
    this.view.caret = position;
    if (this.anchor !== undefined) {
      let from = this.anchor,
        to = position;
      if (this.view.compare(from, to) > 0) [from, to] = [to, from];
      const text = this.document();
      const start = this.offset(from),
        end = this.offset(to);
      if (this.lines) {
        from = this.position(lineStart(text, start)) ?? from;
        to = this.position(lineEnd(text, end)) ?? to;
      } else to = this.position(this.nav.next(text, end)) ?? to;
      this.view.selection = { anchor: from, head: to };
    }
    this.view.ensureVisible(position);
    this.status();
    this.tui.requestFrame();
  }

  private copy(from: TextPosition, to: TextPosition, lines: boolean, source = false): void {
    if (this.view.compare(from, to) > 0) [from, to] = [to, from];
    const value = this.view.text({ from, to }, source ? "source" : "display");
    this.registers.save(value, lines, "y", this.register);
    if (this.register !== "_") this.tui.copy(value);
    this.remember();
    this.anchor = undefined;
    this.lines = false;
    this.view.selection = undefined;
    this.settle(from);
  }

  private visualCopy(source = false): void {
    const selection = this.view.selection;
    const caret = this.view.caret;
    if (selection !== undefined) this.copy(selection.anchor, selection.head, this.lines, source);
    else if (caret !== undefined) {
      const text = this.document(),
        at = this.offset(caret);
      const from = this.position(lineStart(text, at)),
        to = this.position(lineEnd(text, at));
      if (from !== undefined && to !== undefined) this.copy(from, to, true, source);
    }
  }

  private search(at: number, forward: boolean, count: number): number {
    const text = this.document();
    if (this.query === "") return -1;
    let position = at;
    for (let repeat = 0; repeat < count; repeat += 1) {
      let cursor = position,
        found = -1;
      for (let tries = 0; tries <= text.length; tries += 1) {
        let next = forward
          ? text.indexOf(this.query, cursor + 1)
          : cursor > 0
            ? text.lastIndexOf(this.query, cursor - 1)
            : -1;
        if (next < 0) next = forward ? text.indexOf(this.query) : text.lastIndexOf(this.query);
        if (next < 0 || (next === position && tries > 0)) break;
        const end = next + this.query.length;
        if (
          this.nav.snap(text, next) === next &&
          this.nav.snap(text, end) === end &&
          (!this.whole ||
            ((next === 0 || this.nav.wordClass(text, this.nav.previous(text, next)) < 2) &&
              (end === text.length || this.nav.wordClass(text, end) < 2)))
        ) {
          found = next;
          break;
        }
        if (next === cursor) break;
        cursor = next;
      }
      if (found < 0) return -1;
      position = found;
    }
    return position;
  }

  private openSearch(forward: boolean): void {
    const editor = new TextEditor({
      state: { text: this.query, selection: { anchor: 0, head: this.query.length }, spans: [] },
    });
    const origin = this.view.caret;
    const operator = this.operator,
      register = this.register;
    const dialog = this.tui.dialog({
      title: () => "Search transcript · literal, case-sensitive",
      body: editor,
      rows: 3,
      signal: this.mount.signal,
      keys: [
        {
          key: "enter",
          label: "find",
          run: () => {
            this.query = editor.state.text || this.query;
            this.forward = forward;
            this.whole = false;
            dialog.close();
            if (this.mount.signal.aborted || origin === undefined || this.view.caret !== origin) return;
            const found = this.search(this.offset(origin), forward, 1);
            const target = found < 0 ? undefined : this.position(found);
            if (target !== undefined) {
              if (operator) {
                this.register = register;
                this.copy(origin, target, false);
                this.cancel();
              } else this.settle(target);
            }
          },
        },
      ],
    });
  }

  private key(event: KeyEvent): boolean {
    const key = strokeOf(event);
    if (this.tui.keys.pending() !== "" && key !== "esc" && key !== "ctrl+[") {
      this.cancel();
      return false;
    }
    if (key === "tab") {
      const editor = this.tui.widgets
        .list()
        .find((entry) => entry.group === this.mount.group && entry.widget.role === "composer")?.widget;
      if (editor !== undefined) this.tui.focus(editor);
      return true;
    }
    if (key === "esc" || key === "ctrl+[") {
      this.cancel();
      this.remember();
      this.anchor = undefined;
      this.view.selection = undefined;
      this.status();
      return true;
    }
    if (event.modifiers.ctrl || event.modifiers.super || (event.modifiers.alt && key !== "alt+/")) {
      this.cancel();
      return false;
    }
    this.focus();
    const origin = this.view.caret;
    if (origin === undefined) return true;
    const text = this.document(),
      at = this.offset(origin);
    const counted = this.count !== 0 || this.leading !== 0,
      count = (this.count || 1) * (this.leading || 1);
    if (this.phase === "register") {
      this.phase = "";
      if (/^[a-zA-Z0-9"_-]$/.test(key)) this.register = key;
      else this.cancel();
      return true;
    }
    if (this.phase === "mark") {
      const id = this.view.document.key;
      let marks = this.marks.get(id);
      if (this.prefix === "m") {
        if (marks === undefined) {
          marks = new Map();
          this.marks.set(id, marks);
        }
        marks.set(key, origin);
      } else {
        const marked = marks?.get(key);
        if (marked !== undefined && this.view.rows.point(marked) !== undefined) {
          const target =
            this.prefix === "'" ? (this.position(firstNonblank(text, this.offset(marked))) ?? marked) : marked;
          if (this.operator) this.copy(origin, target, this.prefix === "'");
          else this.settle(target);
        } else this.ctx.notify("warn", `Transcript mark ${key} is unavailable.`);
      }
      this.cancel();
      return true;
    }
    let motion = key,
      glyph = "";
    if (this.phase === "character") {
      motion = this.prefix;
      glyph = key;
      this.phase = "";
    } else if (this.phase === "prefix" || this.phase === "object") {
      motion = this.prefix + key;
      this.phase = "";
    } else {
      if (/^[0-9]$/.test(key) && (key !== "0" || this.count !== 0)) {
        this.count = this.count * 10 + Number(key);
        if (this.count * (this.leading || 1) > 10_000) {
          this.cancel();
          this.ctx.notify("warn", "Vim count exceeds 10000");
        }
        return true;
      }
      if (key === '"') {
        this.phase = "register";
        return true;
      }
      if ((key === "m" && !this.operator) || key === "'" || key === "`") {
        this.phase = "mark";
        this.prefix = key;
        return true;
      }
      if (["f", "F", "t", "T"].includes(key)) {
        this.phase = "character";
        this.prefix = key;
        return true;
      }
      if (key === "g") {
        this.phase = "prefix";
        this.prefix = key;
        return true;
      }
      if ((this.operator || this.anchor !== undefined) && (key === "i" || key === "a")) {
        this.phase = "object";
        this.prefix = key;
        return true;
      }
      if (key === "y" && !this.operator) {
        if (this.anchor !== undefined) {
          this.visualCopy();
          this.cancel();
        } else {
          this.operator = true;
          this.leading = count;
          this.count = 0;
        }
        return true;
      }
      if (key === "v" || key === "V") {
        if (this.anchor !== undefined && this.lines === (key === "V")) {
          this.remember();
          this.anchor = undefined;
          this.view.selection = undefined;
        } else {
          this.anchor ??= origin;
          this.lines = key === "V";
        }
        this.settle(origin);
        this.cancel();
        return true;
      }
      if (key === "o" && this.anchor !== undefined) {
        const anchor = this.anchor;
        this.anchor = origin;
        this.settle(anchor);
        this.cancel();
        return true;
      }
      if (key === "/" || key === "?" || key === "alt+/") {
        this.openSearch(key !== "?");
        this.cancel();
        return true;
      }
    }
    if (motion === "gy") {
      this.visualCopy(true);
      this.cancel();
      return true;
    }
    if (motion === "gv") {
      const saved = this.previousVisual;
      if (
        saved !== undefined &&
        this.view.rows.point(saved.anchor) !== undefined &&
        this.view.rows.point(saved.head) !== undefined
      ) {
        this.anchor = saved.anchor;
        this.lines = saved.lines;
        this.settle(saved.head);
      }
      this.cancel();
      return true;
    }
    if (motion === "enter") {
      this.view.activate(origin);
      this.cancel();
      return true;
    }
    let target = -1,
      inclusive = false,
      lines = false;
    const point = this.view.rows.point(origin);
    if (
      motion === "j" ||
      motion === "k" ||
      motion === "gj" ||
      motion === "gk" ||
      motion === "up" ||
      motion === "down"
    ) {
      if (point !== undefined) {
        this.goal ??= point.column;
        const destination = this.view.rows.at({
          row: Math.max(
            0,
            Math.min(
              this.view.rows.count - 1,
              point.row + (motion.endsWith("j") || motion === "down" ? count : -count),
            ),
          ),
          column: this.goal,
        });
        if (destination !== undefined) target = this.offset(destination);
      }
      lines = true;
    } else {
      this.goal = undefined;
      if (motion === "h" || motion === "left" || motion === "l" || motion === "right") {
        target = at;
        for (let n = 0; n < count; n += 1)
          target =
            motion === "h" || motion === "left"
              ? Math.max(lineStart(text, target), this.nav.previous(text, target))
              : Math.min(this.nav.clamp(text, lineEnd(text, target)), this.nav.next(text, target));
      } else if (motion === "0" || motion === "home") target = lineStart(text, at);
      else if (motion === "^") target = firstNonblank(text, at);
      else if (motion === "$" || motion === "end") {
        target = this.nav.clamp(text, lineEnd(text, this.starts[(point?.row ?? 0) + count - 1] ?? at));
        inclusive = true;
      } else if (motion === "w" || motion === "W")
        target = this.nav.wordStart(text, at, count, motion === "W", this.operator);
      else if (motion === "b" || motion === "B") target = this.nav.wordBack(text, at, count, motion === "B");
      else if (motion === "e" || motion === "E") {
        target = this.nav.wordEnd(text, at, count, motion === "E");
        inclusive = true;
      } else if (motion === "ge" || motion === "gE") {
        target = this.nav.previousEnd(text, at, count, motion === "gE");
        inclusive = true;
      } else if (motion === "{" || motion === "}") target = this.nav.paragraph(text, at, motion === "}", count);
      else if (motion === "%" && !counted) {
        target = this.nav.match(text, at);
        inclusive = true;
      } else if (motion === "gg" || motion === "G" || motion === "%") {
        const row =
          motion === "%"
            ? Math.ceil((this.starts.length * Math.min(count, 100)) / 100) - 1
            : motion === "G" && !counted
              ? this.starts.length - 1
              : count - 1;
        target = this.starts[Math.min(row, this.starts.length - 1)] ?? -1;
        lines = true;
      } else if (motion === "J" || motion === "K") {
        const sections = this.view.document.items.flatMap((item) =>
          item.sections.map((section) => ({ item: item.key, section: section.key, offset: 0 })),
        );
        const index = sections.findIndex((value) => value.item === origin.item && value.section === origin.section);
        let next = index;
        for (let n = 0; n < count; n += 1) {
          do {
            next += motion === "J" ? 1 : -1;
          } while (sections[next] !== undefined && !this.visible(sections[next]));
        }
        const position = sections[next];
        if (position !== undefined) target = this.offset(position);
      } else if ((motion === "y" && this.operator) || motion === "Y") {
        target = this.starts[Math.min((point?.row ?? 0) + count - 1, this.starts.length - 1)] ?? at;
        lines = true;
        this.operator = true;
      } else if (/^[ia].$/.test(motion)) {
        const range = this.nav.object(text, at, motion[1] ?? "", motion[0] === "a", count);
        if (range !== null) {
          const from = this.position(range.from),
            to = this.position(range.to);
          if (from !== undefined && to !== undefined) {
            if (this.operator) this.copy(from, to, false);
            else {
              this.anchor = from;
              this.lines = false;
              const head = this.position(this.nav.previous(text, range.to));
              if (head !== undefined) this.settle(head);
            }
          }
        }
        this.cancel();
        return true;
      } else if (["f", "F", "t", "T", ";", ","].includes(motion)) {
        let kind = motion;
        const repeat = motion === ";" || motion === ",";
        if (repeat) {
          const opposite: Record<string, string> = { f: "F", F: "f", t: "T", T: "t" };
          kind = motion === ";" ? this.find : (opposite[this.find] ?? "");
          glyph = this.glyph;
        } else {
          this.find = motion;
          this.glyph = glyph;
        }
        const start = lineStart(text, at),
          body = text.slice(start, lineEnd(text, at));
        const found = this.nav.find(body, at - start, kind, glyph, count, repeat);
        if (found >= 0) target = start + found;
        inclusive = kind === "f" || kind === "t";
      } else if (["n", "N", "*", "#", "g*", "g#"].includes(motion)) {
        if (motion.includes("*") || motion.includes("#")) {
          let start = at;
          const end = lineEnd(text, at);
          while (start < end && this.nav.wordClass(text, start) < 2) start = this.nav.next(text, start);
          if (start === end) {
            this.cancel();
            return true;
          }
          const range = this.nav.object(text, start, "w", false, 1);
          if (range !== null) this.query = text.slice(range.from, range.to);
          this.forward = motion.includes("*");
          this.whole = motion.length === 1;
        }
        target = this.search(at, motion === "N" ? !this.forward : this.forward, count);
      } else {
        this.cancel();
        return false;
      }
    }
    if (target >= 0) {
      let from = origin;
      if (this.operator) {
        let start = Math.min(at, target),
          end = Math.max(at, target);
        if (lines) {
          start = lineStart(text, start);
          end = lineEnd(text, end);
        } else if (inclusive) end = this.nav.next(text, end);
        from = this.position(start) ?? origin;
        const to = this.position(end);
        if (to !== undefined) this.copy(from, to, lines);
      } else {
        const destination = this.position(this.nav.clamp(text, target));
        if (destination !== undefined) this.settle(destination);
      }
    }
    this.cancel();
    return true;
  }
}
