import { assert, assertEquals } from "yuke:test";
import { scenario } from "./support.ts";

for (const width of [32, 100]) {
  scenario(
    `the composer grows with its draft, keeps its cursor aligned, and contracts at width ${width}`,
    {
      width,
      height: 30,
    },
    async (s) => {
      s.frame.key("ctrl+k b");
      // The rows between the rule above the composer and the footer.
      const fieldHeight = () => {
        const rows = s.frame.rows();
        const rule = rows.findLastIndex((line) => /^─+$/.test(line.trim()));
        assert(rule >= 0, rows.join("\n"));
        return rows.length - rule - 2;
      };
      const clear = () => {
        // Each pair deletes to the start of a line, then the line break before it.
        for (let line = 0; line < 8; line++) {
          s.frame.key("ctrl+u");
          s.frame.key("backspace");
        }
        assertEquals(fieldHeight(), 1, "Clearing the draft restores a single input row.");
      };

      assertEquals(fieldHeight(), 1, "An empty composer does not reserve three content rows.");
      const rows = s.frame.rows();
      const placeholderRow = rows.findIndex((line) => line.includes("Ask a side question"));
      assertEquals(s.frame.frame.cursor?.row, placeholderRow);
      assertEquals(
        s.frame.frame.cursor?.column,
        (rows[placeholderRow] ?? "").indexOf("Ask a side question") - 1,
        "The block cursor belongs before the placeholder.",
      );
      const footer = rows.at(-1) ?? "";
      assert(footer.includes("Enter send") && footer.includes("Esc close"), footer);
      assertEquals(
        footer.includes("Ctrl+R history"),
        width >= 80,
        "The footer drops the history hint where it does not fit.",
      );

      s.frame.paste("x".repeat(27));
      assertEquals(fieldHeight(), width === 32 ? 2 : 1, "Only a narrow field wraps this draft.");
      s.frame.resize({ width: width === 32 ? 100 : 32, height: 30 });
      assertEquals(fieldHeight(), width === 32 ? 1 : 2, "Resizing reflows the draft.");
      s.frame.resize({ width, height: 30 });
      clear();

      s.frame.paste("first");
      s.frame.key("shift+enter");
      s.frame.paste("second");
      assertEquals(fieldHeight(), 2, "A newline adds a content row.");
      s.frame.key("ctrl+j");
      s.frame.paste("third");
      assertEquals(fieldHeight(), 3);
      s.frame.key("alt+enter");
      s.frame.paste("fourth");
      assertEquals(fieldHeight(), 3, "A longer draft scrolls within the bounded composer.");
      assertEquals(s.frame.frame.cursor?.row, s.frame.frame.height - 2, "The caret stays visible above the footer.");
      clear();

      s.frame.paste("abcdef");
      const cursor = s.frame.frame.cursor;
      assert(cursor !== undefined);
      s.frame.key("tab");
      s.frame.click(cursor.column - 4, cursor.row);
      s.frame.paste("X");
      assert(
        s.frame.rows().some((line) => line.includes("abXcdef")),
        "A click places the caret at the clicked cell.",
      );
    },
  );
}
