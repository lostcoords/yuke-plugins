#!/usr/bin/env python3
"""Compare supported editing sequences with real Vim. Use UTF-16 offsets and isolated stores."""
import json
from pathlib import Path
import subprocess
import tempfile
from support import run

package = Path(__file__).resolve().parents[1]
cases = [
    ("alpha beta", 0, "w"), ("alpha beta", 0, "e"), ("alpha beta", 6, "b"),
    ("foo!!!bar baz", 0, "w"), ("foo!!!bar baz", 3, "w"), ("foo!!!bar baz", 0, "W"),
    ("alpha\n\nbravo", 0, "w"), ("alpha\n\nbravo", 7, "b"), ("alpha\n\nbravo", 4, "e"),
    ("alpha\n\nbravo", 7, "ge"), ("alpha\n\nbravo", 0, "2w"),
    ("abc中文かなカナxyz end", 0, "w"), ("abc中文かなカナxyz end", 3, "w"),
    ("abc中文かなカナxyz end", 5, "w"), ("abc中文かなカナxyz end", 7, "w"),
    ("a\u200bb end", 0, "w"), ("foo\rbar baz", 0, "w"), ("a×b next", 0, "w"),
    ("alpha beta", 0, "dw"), ("alpha beta", 3, "dw"), ("alpha beta", 0, "de"),
    ("alpha beta", 6, "db"), ("alpha\nbravo", 0, "dw"), ("alpha\nbravo", 0, "2dw"),
    ("alpha\nbravo", 6, "db"), ("alpha\n\nbravo", 0, "dw"),
    ("alpha beta", 0, "cw\x1b"), ("alpha beta", 5, "cw\x1b"), ("foo,bar", 0, "c2w\x1b"),
    ("foo,bar baz", 0, "dW"), ("foo,bar baz", 8, "dB"),
    ("one two three four five", 0, "2d2w"), ("one two three four", 0, "d2w"),
    ("a\nb\nc\nd", 0, "3dd"), ("a\nb\nc\nd", 0, "2d2d"),
    ("a\nb\nc", 2, "dd"), ("a\nb", 2, "dd"), ("a\nb\nc", 2, "ddp"),
    ("a\nb", 2, "ddP"), ("a\nb\nc", 2, "cc\x1b"), ("  a\nb\nc", 2, "ccX\x1b"),
    ("a\nb\nc", 2, "dj"), ("a\nb\nc", 2, "dk"), ("a\nb\nc", 2, "dG"),
    ("a\nb\nc", 2, "dgg"), ("  a\n  b\nc", 0, "2G"), ("  a\n  b\nc", 8, "gg"),
    ("  a\n  b\nc\nd", 0, "50%"), ("abcdef\nx\nabcdef", 4, "jj"),
    ("foo!!!bar", 4, "diw"), ("foo   bar", 4, "diw"), ("foo bar", 4, "daw"),
    ("foo bar", 0, "2diw"), ("foo bar baz", 0, "2daw"), ("foo,bar baz", 4, "diW"),
    ('say "hello" now', 6, 'ci"new\x1b'), ("say 'hello' now", 6, "da'"),
    ('say "hello" now', 6, '2di"'), ('say "a\\\"b" now', 7, 'di"'),
    ("f(one (two) three)", 8, "di("), ("f(one (two) three)", 8, "d2i("),
    ("f(one (two) three)", 8, "da)"), ("a[one]b", 3, "di]"), ("a{one}b", 3, "ciB\x1b"),
    ("plain text", 0, 'di"'), ("foo()bar", 3, "ci(X\x1b"),
    ("a,b,c,d", 0, "f,"), ("a,b,c,d", 0, "f,;"), ("a,b,c,d", 0, "f,;,;"),
    ("a,b,c,d", 0, "2f,"), ("a,b,c,d", 0, "t,;"), ("a,b,c,d", 6, "T,;"),
    ("foo(bar)baz", 4, "dt)"), ("foo(bar)baz", 4, "df)"), ("foo(bar)baz", 6, "dF("),
    ("foo(bar)baz", 6, "dT("), ("abc\ndef", 0, "fz"),
    ("a(b[c]d)e", 1, "%"), ("a(b[c]d)e", 1, "d%"), ('f(")")', 1, "%"),
    ("(I can't do this)", 0, "%"), ("one\ntwo\n\nthree\n\nfour", 0, "}"),
    ("one\ntwo\n\nthree", 0, "d}"),
    ("abc", 0, "iXY\x1b"), ("abc", 1, "aXY\x1b"), ("  abc", 4, "IX\x1b"),
    ("abc", 0, "oX\x1b"), ("abc", 0, "OX\x1b"), ("abc", 0, "3iX\x1b"),
    ("a\nb", 0, "3oX\x1b"), ("abc", 0, "x"), ("abc", 0, "3x"),
    ("abc", 2, "X"), ("abc def", 2, "sX\x1b"), ("abc\ndef", 0, "2SXY\x1b"),
    ("abc\ndef", 0, "2D"), ("abc\ndef", 0, "2CXY\x1b"), ("abc\ndef", 0, "Yp"),
    ("abc def", 0, "rx"), ("abc def", 1, "2rx"), ("abc", 1, "3rx"),
    ("abc def", 0, "r/"), ("abc def", 0, "r\r"),
    ("one\n  two\nthree", 0, "J"), ("one\n  two\nthree", 1, "3J"),
    ("one\n  two", 0, "gJ"), ("one\n )", 0, "J"), ("one\n\nthree", 0, "3J"),
    ("AbC dEf", 0, "~"), ("AbC dEf", 0, "3~"), ("AbC dEf", 0, "gUiw"),
    ("AbC dEf", 0, "guw"), ("AbC dEf", 0, "g~w"), ("AbC\ndEf\nGhI", 0, "2gUU"),
    ("one\ntwo\nthree", 0, ">>"), ("one\ntwo\nthree", 0, "2>>"),
    ("one\ntwo\nthree", 0, ">j"), ("  one\n    two", 0, "2<<"),
    ("alpha beta", 0, "vwd"), ("alpha beta", 2, "viwy$p"), ("a\nb\nc", 0, "Vjd"),
    ("a\nb\nc", 0, "VjcX\x1b"), ("abc", 0, "vlo"), ("abc", 0, "vl\x1bgvy"),
    ("abc", 0, "vllrx"), ("AbC", 0, "vlU"), ("one\ntwo", 0, "Vj3>"),
    ("one\n  two", 0, "VgJ"), ("abc def", 0, "yiwwviwp"), ("abc def", 0, "yiwwviwP"),
    ("abc def", 0, '"ayiw w"ap'), ("abc def", 0, '"ayiw w"Ayiw $p'),
    ("abc\ndef", 0, '"ayy j"Ayy p'), ("abc def", 0, 'yiww"_diwP'),
    ("abc def", 0, 'yiwwdiw"0P'), ("abc\ndef\nghi", 0, 'dd dd"2p'),
    ("abc def", 0, '"ayiwAi\x12a\x1b'), ("abc def", 0, "maw`a"),
    ("  abc\n  def", 3, "maG'a"), ("abc\ndef\nghi", 1, "maGd`a"),
    ("one ones one one", 0, "*"), ("one ones one one", 0, "2*"),
    ("one ones one one", 0, "*N"), ("one ones one one", 0, "g*"),
    ("one two one", 0, "d*"),
    ("hola\nchao", 8, "A\x17\x1b"), ("hola\n chao  ", 9, "A\x17\x1b"),
    ("foo!!!bar", 8, "A\x17\x1b"), ("foo!!!", 5, "A\x17\x1b"),
    ("abc\ndef", 0, "yyjVp."),
    ("alpha beta", 0, "dwu"), ("abc", 0, "iXYZ\x1bu"),
    # Undo and redo keep the repeat recipe, and a repeated edit has its own history group.
    ("one two three four", 0, "dwu\x12.2u2\x12"),
    ("abc", 0, "iX\x02Y\x1bu"), ("abc", 0, "iX\x02Y\x1bu\x12"), ("abc", 0, "iXYZ\x1bu\x12"),
    ("alpha beta", 0, "cwX\x1bu"), ("one two three four", 0, "dw."),
    ("one two three four five", 0, "dw2."), ("alpha beta gamma", 0, "cwX\x1bw."),
    ("abc def", 0, "rxw."),
    ("one\ntwo\nthree", 0, ">>j."), ("a\nb\nc", 0, "ddp."),
    ("abc def ghi", 0, "yiwwviwP."), ("abc def ghi", 0, "yiwwviwp."),
    ("abc", 0, "3iX\x1bl."), ("abc", 0, "iX\x1bl3."),
    ("abc def", 3, "max`a"), ("abc def", 4, "ma0iX\x1b`a"),
    ("abc\ndef", 0, "maGdd'a"), ("abc\ndef", 0, "maGdduG'a"),
    ("one\ntwo", 0, ">>u"), ("one\ntwo", 0, ">>u\x12"),
    ("abc def", 0, "vllrx."), ("abc def", 0, "vlld."),
    ("abc\ndef", 0, "yiwjVp"), ("abc\ndef", 0, "yyjvp"),
    ("abc def", 0, '"ayiw w"_yiw "ap'),
    ("alpha beta", 0, "yw$p"), ("alpha beta", 6, "yb$p"),
    ("alpha beta", 6, "yge$p"),
]

# Seeded combinations pin the motion/range grammar, not individual constants.
import random
random.seed(0)
fixtures = ["a b c", "ab!!!cd  ef", " a  b ", "a\n\nb", "ab\n  cd\nef", "ab\n\n\ncd", "a\tb\nc", "a×b 中文かな end"]
commands = ["w", "b", "e", "ge", "W", "B", "E", "gE", "dw", "db", "de", "dW", "dB", "dE", "dge", "diw", "daw", "diW", "daW", "cw\x1b", "ciw\x1b", "caw\x1b"]
for n in range(400):
    text = random.choice(fixtures)
    at = random.randrange(len(text))
    if text[at] == "\n" and (at > 0 and text[at - 1] != "\n"):
        at -= 1
    command = random.choice(commands)
    if random.randrange(3) == 0:
        command = str(random.randrange(2, 5)) + command
    cases.append((text, at, command))

def vim_string(value):
    return json.dumps(value, ensure_ascii=False).replace("\\u001b", "\\<Esc>").replace("\\u0012", "\\<C-R>").replace("\\b", "\\<BS>").replace("\\u0017", "\\<C-W>").replace("\\u0002", "\\<Left>")

with tempfile.TemporaryDirectory(prefix="vim-reference-") as directory:
    out = Path(directory) / "expected.jsonl"
    commands = ["set nocompatible encoding=utf-8 nomore", "set iskeyword=@,48-57,_,192-255 shiftwidth=2 tabstop=2 expandtab nojoinspaces backspace=indent,eol,start", f"call writefile([], {vim_string(str(out))})"]
    for text, at, strokes in cases:
        row = text[:at].count("\n") + 1
        column = len(text[:at].rsplit("\n", 1)[-1].encode()) + 1
        commands += ['execute "normal! \\<Esc>"', "enew!", "call setline(1, " + json.dumps(text.split("\n"), ensure_ascii=False) + ")", f"call cursor({row}, {column})", "let &undolevels = &undolevels", "call feedkeys(" + vim_string(strokes) + ", 'xt')", f'call writefile([json_encode({{"text":join(getline(1,"$"),"\\n"),"row":line("."),"col":col(".")}})], {vim_string(str(out))}, "a")']
    commands += ["qa!"]
    subprocess.run(["vim", "-Nu", "NONE", "-i", "NONE", "-n", "-es", "-S", "/dev/stdin"], input="\n".join(commands) + "\n", text=True, check=True, timeout=30)
    expected = []
    for line in out.read_text().splitlines():
        item = json.loads(line)
        rows = item["text"].split("\n")
        prefix = "\n".join(rows[:item["row"] - 1]) + ("\n" if item["row"] > 1 else "")
        prefix += rows[item["row"] - 1].encode()[:item["col"] - 1].decode()
        expected.append({"text": item["text"], "caret": len(prefix.encode("utf-16-le")) // 2})
    source = '''//! Compare the real root dispatch with headless Vim.
import apply from PLUGIN;
import { ChatView } from "yuke:chat";
import { quit } from "yuke:ui";
/** Run isolated parity cases. No TUI skips the probe. An invariant failure is reported. @param {import("yuke").Context} ctx */
export default function(ctx) {
 apply(ctx);
 const tui = ctx.get("tui"); if (!tui) return;
 ctx.once("ui.started", () => {
  const view = tui.root.active; if (!(view instanceof ChatView)) throw Error("missing chat");
  const c = view.composer, cases = CASES, expected = EXPECTED;
  c.layout({ x:0, y:0, w:80, h:20 });
  let failures = 0;
  for (let n=0; n<cases.length; n++) {
   const [text, at, strokes] = cases[n];
   tui.command.perform("vim-mode:normal"); view.focusRegion("composer"); c.input.setText(text); c.input.caret = at;
   for (const char of strokes) {
    const code = char === "\\x1b" ? "esc" : char === "\\x08" ? "backspace" : char === "\\r" ? "enter" : char === "\\x02" ? "left" : "char";
    const mods = char === "\\x12" || char === "\\x17" ? 4 : 0, value = mods ? char === "\\x17" ? "w" : "r" : code === "char" ? char : "";
    tui.root.onEvent({type:"key", event:"press", code, char:value, text:mods?"":value, mods, shifted:"", baseLayout:""});
   }
   if (c.input.text !== expected[n].text || c.input.caret !== expected[n].caret) {
    failures++; ctx.print("VIM_FAIL " + JSON.stringify({n, text, at, strokes, actual:{text:c.input.text,caret:c.input.caret}, expected:expected[n]}));
   }
  }
  ctx.print("PARITY " + cases.length + " cases; " + failures + " failures"); quit();
 });
}
'''.replace("PLUGIN", json.dumps(str(package / "index.js"))).replace("CASES", json.dumps(cases, ensure_ascii=False)).replace("EXPECTED", json.dumps(expected, ensure_ascii=False))
    logs = run(source, timeout=60)
    print(next(line for line in logs.splitlines() if "PARITY " in line))
