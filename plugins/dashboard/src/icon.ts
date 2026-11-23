/**
 * The icon of yuke in sextant cells, as the stock header of an empty chat draws it. The stock module is internal, so
 * this is a copy.
 */

import type { Canvas, Style } from "yuke:tui";

/** One character per pixel: `.` none, `g` face, `e` eye, `w` highlight. A sextant cell shows 2 x 3 pixels. */
const PIXELS = [
  "..ggg..............ggg..",
  "......ggg......ggg......",
  "........gg....gg........",
  "......gggggggggggg......",
  "..gegeeeggggggggeeegeg..",
  "..ewwweeeggggggeeewwwe..",
  "..eeeeeeeeggggeeeeeeee..",
  "..ggeeeeeeggggeeeeeegg..",
  "....ggeeeggggggeeegg....",
  "......gggggggggggg......",
  "........gggggggg........",
  "..........gggg..........",
];

const COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  g: [0xa8, 0xcf, 0xa0],
  e: [0x26, 0x28, 0x26],
  w: [0xf4, 0xf2, 0xeb],
};

export const ICON_WIDTH = (PIXELS[0]?.length ?? 0) / 2;
export const ICON_ROWS = PIXELS.length / 3;

const hex = (color: readonly [number, number, number]): `#${string}` =>
  `#${color.map((part) => part.toString(16).padStart(2, "0")).join("")}`;

/** The green of the face, for text that goes with the icon. */
export const ACCENT: Style = { fg: hex(COLORS.g ?? [0, 0, 0]) };

/** The sextant of `bits`: bit `n` is the pixel `n` of a 2 x 3 cell, row by row. */
function sextant(bits: number): string {
  if (bits === 0) return " ";
  if (bits === 63) return "█";
  // The left and the right half are older block characters, so the sextant block leaves them out.
  if (bits === 21) return "▌";
  if (bits === 42) return "▐";
  return String.fromCodePoint(0x1_fb_00 + bits - 1 - (bits > 21 ? 1 : 0) - (bits > 42 ? 1 : 0));
}

const distance = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, part, index) => sum + (part - (b[index] ?? 0)) ** 2, 0);

/** The most common color draws the sextant, and the second one fills the cell unless a pixel is empty. */
function cell(pixels: readonly string[]): readonly [string, Style | undefined] {
  const counts = new Map<string, number>();
  for (const pixel of pixels) if (pixel !== ".") counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
  const ranked = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const fg = ranked[0];
  if (fg === undefined) return [" ", undefined];
  const bg = pixels.includes(".") ? undefined : ranked[1];
  const fgColor = COLORS[fg] ?? [0, 0, 0];
  const lit = (pixel: string): boolean => {
    if (pixel === fg) return true;
    if (pixel === "." || pixel === bg) return false;
    const color = COLORS[pixel] ?? [0, 0, 0];
    return bg === undefined || distance(color, fgColor) <= distance(color, COLORS[bg] ?? [0, 0, 0]);
  };
  const bits = pixels.reduce((sum, pixel, index) => sum + (lit(pixel) ? 1 << index : 0), 0);
  const style: Style = bg === undefined ? { fg: hex(fgColor) } : { fg: hex(fgColor), bg: hex(COLORS[bg] ?? [0, 0, 0]) };
  return [sextant(bits), style];
}

const CELLS = Array.from({ length: ICON_ROWS }, (_, row) =>
  Array.from({ length: ICON_WIDTH }, (_, column) =>
    cell([0, 1, 2].flatMap((dy) => [0, 1].map((dx) => PIXELS[3 * row + dy]?.[2 * column + dx] ?? "."))),
  ),
);

/** Draw the icon with its top left cell at `column`, `row`. */
export function drawIcon(canvas: Canvas, column: number, row: number): void {
  for (const [y, cells] of CELLS.entries()) {
    for (const [x, [character, style]] of cells.entries()) {
      if (style !== undefined) canvas.text(column + x, row + y, character, style);
    }
  }
}
