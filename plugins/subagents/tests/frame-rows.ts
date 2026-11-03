import type { Frame } from "yuke:test";

/** The text of each row of `frame`. */
export function rowsOf(frame: Frame): string[] {
  return frame.cells.map((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .trimEnd(),
  );
}
