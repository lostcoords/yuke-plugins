export interface Register {
  readonly text: string;
  readonly linewise: boolean;
}

/** Own the registers shared by composer edits. */
export class Registers {
  private unnamed: Register = { text: "", linewise: false };
  private readonly named = new Map<string, Register>();

  read(name: string): Register | undefined {
    return name === '"' ? this.unnamed : this.named.get(name.toLowerCase());
  }

  save(value: string, lines: boolean, operator: string, name = '"'): void {
    if (name === "_") return;

    if (name !== '"') {
      const lower = name.toLowerCase();
      const previous = this.named.get(lower);
      if (name !== lower && previous) {
        value = previous.text + (previous.linewise ? "\n" : "") + value;
        lines = previous.linewise || lines;
      }
      this.named.set(lower, { text: value, linewise: lines });
    } else if (operator === "y") {
      this.named.set("0", { text: value, linewise: lines });
    } else if (lines || value.includes("\n")) {
      for (let number = 9; number > 1; number--) {
        const previous = this.named.get(String(number - 1));
        if (previous) this.named.set(String(number), previous);
        else this.named.delete(String(number));
      }
      this.named.set("1", { text: value, linewise: lines });
    } else {
      this.named.set("-", { text: value, linewise: lines });
    }

    this.unnamed = { text: value, linewise: lines };
  }

  clear(): void {
    this.unnamed = { text: "", linewise: false };
    this.named.clear();
  }
}
