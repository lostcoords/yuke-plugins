//! One register owner shared by composer edits and transcript yanks.
/** @typedef {{ text: string, linewise: boolean }} Register */

/** Own Vim's unnamed, named, yank, small-delete, and numbered registers. Empty entries mean no stored text. No desktop clipboard access or failure. */
export class Registers {
  constructor() {
    this.text = "";
    this.linewise = false;
    /** @type {Map<string, Register>} */
    this.named = new Map();
  }
  /** @param {string} name @returns {Register | null} */
  read(name) { return name === '"' ? this : this.named.get(name.toLowerCase()) || null; }
  /** @param {string} value @param {boolean} lines @param {string} operator @param {string} [name] */
  save(value, lines, operator, name = '"') {
    if (name === "_") return;
    if (name !== '"') {
      const lower = name.toLowerCase(), old = this.named.get(lower);
      if (name !== lower && old) { value = old.text + (old.linewise ? "\n" : "") + value; lines = old.linewise || lines; this.named.set(lower, { text: value, linewise: lines }); }
      else this.named.set(lower, { text: value, linewise: lines });
    } else if (operator === "y") this.named.set("0", { text: value, linewise: lines });
    else if (lines || value.includes("\n")) {
      for (let i = 9; i > 1; i--) {
        const old = this.named.get(String(i - 1));
        if (old) this.named.set(String(i), old); else this.named.delete(String(i));
      }
      this.named.set("1", { text: value, linewise: lines });
    } else this.named.set("-", { text: value, linewise: lines });
    this.text = value;
    this.linewise = lines;
  }
  /** Clear the owned text when the plugin unloads. No failure. */
  clear() { this.text = ""; this.linewise = false; this.named.clear(); }
}
