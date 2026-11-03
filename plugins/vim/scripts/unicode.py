#!/usr/bin/env python3
"""Generate Unicode motion classes from Vim v9.2.1046 with the Python standard library."""
from pathlib import Path
import re
import urllib.request

VERSION = "v9.2.1046"
URL = f"https://raw.githubusercontent.com/vim/vim/{VERSION}/src/mbyte.c"
source = urllib.request.urlopen(URL).read().decode()
classes = source.split("utf_class_buf(int c, buf_T *buf)", 1)[1].split("} classes[] =", 1)[1].split("};", 1)[0]
emoji = source.split("static struct interval emoji_all[]", 1)[1].split("};", 1)[0]


def values(text, size):
    pattern = r"\{\s*(0x[0-9a-f]+),\s*(0x[0-9a-f]+)"
    if size == 3:
        pattern += r",\s*(0x[0-9a-f]+|[0-9]+)"
    rows = re.findall(pattern + r"\s*\}", text)
    def literal(value):
        if not value.startswith("0x"):
            return value
        digits = value[2:]
        first = len(digits) % 2 or 2
        return "0x" + "_".join([digits[:first]] + [digits[index:index + 2] for index in range(first, len(digits), 2)])

    return "\n  ".join(", ".join(literal(value) for value in row) + "," for row in rows)


output = f'''// Generated Unicode motion intervals from Vim {VERSION}. Run scripts/unicode.py.
// Source: {URL}; Vim license: https://github.com/vim/vim/blob/{VERSION}/LICENSE
// biome-ignore format: Keep one Unicode interval on each line.
const classes = new Uint32Array([
  {values(classes, 3)}
]);
// biome-ignore format: Keep one Unicode interval on each line.
const emoji = new Uint32Array([
  {values(emoji, 2)}
]);

/** Vim's default word class for one Unicode code point. */
export function vimClass(code: number): number {{
  if (code < 0x1_00) {{
    if (code === 32 || code === 9 || code === 160) return 0;
    return code === 95 ||
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code >= 192
      ? 2
      : 1;
  }}
  let lower = 0,
    upper = emoji.length / 2 - 1;
  while (lower <= upper) {{
    const middle = (lower + upper) >>> 1,
      at = middle * 2;
    if (code < (emoji[at] as number)) upper = middle - 1;
    else if (code > (emoji[at + 1] as number)) lower = middle + 1;
    else return 3;
  }}
  lower = 0;
  upper = classes.length / 3 - 1;
  while (lower <= upper) {{
    const middle = (lower + upper) >>> 1,
      at = middle * 3;
    if (code < (classes[at] as number)) upper = middle - 1;
    else if (code > (classes[at + 1] as number)) lower = middle + 1;
    else return classes[at + 2] as number;
  }}
  return 2;
}}
'''
Path(__file__).resolve().parents[1].joinpath("src/unicode-classes.ts").write_text(output)
