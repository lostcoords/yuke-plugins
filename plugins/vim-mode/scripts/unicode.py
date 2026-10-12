#!/usr/bin/env python3
"""Generate motion classes from the pinned Vim release. No runtime dependency."""
from pathlib import Path
import re
import urllib.request

VERSION = "v9.2.1046"
URL = f"https://raw.githubusercontent.com/vim/vim/{VERSION}/src/mbyte.c"
source = urllib.request.urlopen(URL).read().decode()
classes = source.split("utf_class_buf(int c, buf_T *buf)", 1)[1].split("} classes[] =", 1)[1].split("};", 1)[0]
emoji = source.split("static struct interval emoji_all[]", 1)[1].split("};", 1)[0]
def values(text, size):
    rows = re.findall(r"\{\s*(0x[0-9a-f]+),\s*(0x[0-9a-f]+)" + (r",\s*(0x[0-9a-f]+|[0-9]+)" if size == 3 else "") + r"\s*\}", text)
    return ",\n  ".join(", ".join(row) for row in rows)
output = f'''//! Generated Unicode motion intervals from Vim {VERSION}. Run scripts/unicode.py.
// Source: {URL}; Vim license: https://github.com/vim/vim/blob/{VERSION}/LICENSE
const classes = new Uint32Array([
  {values(classes, 3)}
]);
const emoji = new Uint32Array([
  {values(emoji, 2)}
]);

/** Vim's default word class for one code point. The tables own their bytes. No null result or failure. @param {{number}} code @returns {{number}} */
export function vimClass(code) {{
  if (code < 0x100) {{
    if (code === 32 || code === 9 || code === 160) return 0;
    return code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 192 ? 2 : 1;
  }}
  let lo = 0, hi = emoji.length / 2 - 1;
  while (lo <= hi) {{
    const mid = (lo + hi) >>> 1, at = mid * 2;
    if (code < emoji[at]) hi = mid - 1;
    else if (code > emoji[at + 1]) lo = mid + 1;
    else return 3;
  }}
  lo = 0; hi = classes.length / 3 - 1;
  while (lo <= hi) {{
    const mid = (lo + hi) >>> 1, at = mid * 3;
    if (code < classes[at]) hi = mid - 1;
    else if (code > classes[at + 1]) lo = mid + 1;
    else return classes[at + 2];
  }}
  return 2;
}}
'''
Path(__file__).resolve().parents[1].joinpath("unicode-classes.js").write_text(output)
