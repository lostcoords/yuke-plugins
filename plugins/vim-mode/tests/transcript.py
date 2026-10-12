#!/usr/bin/env python3
"""Pin read-only transcript grammar against typed Vim and session-local source anchors."""
import json
from pathlib import Path
import subprocess
import tempfile
from support import run

plugin = Path(__file__).resolve().parents[1] / "index.js"
cases = [
    ("  one,two,three", 0, "^"), ("  one,two,three", 0, "f,"),
    ("  one,two,three", 0, "2f,"), ("  one,two,three", 0, "f,;"),
    ("  one,two,three", 0, "t,;"), ("  one,two,three", 0, "t,;,"),
    ("  one,two,three", 10, "F,"), ("  one,two,three", 10, "T,"),
    ("one two three", 8, "ge"), ("one,two three", 8, "gE"),
    ("one\ntwo\nthree", 0, "2G"), ("one\ntwo\nthree", 10, "gg"),
    ("one\ntwo\nthree", 0, "G"), ("one two three", 0, "2w"),
    ("f(one [two])", 1, "%"), ("f(one [two])", 10, "%"),
    ("one two", 0, "yw"), ("one two", 0, "ye"), ("one two", 4, "yb"),
    ("one,two,three", 0, "yf,"), ("one,two,three", 0, "yt,"),
    ("one,two,three", 9, "yF,"), ("one,two,three", 9, "yT,"),
    ("one two three four five", 0, "2y2w"),
    ("one\ntwo\nthree", 0, "2yy"), ("one\ntwo\nthree", 0, "yj"),
    ("one two", 1, "yiw"), ("one two", 1, "yaw"),
    ('say "hello" now', 6, 'yi"'), ("f(one [two])", 8, "yi["),
    ("f(one [two])", 8, "ya("), ("f(one (two) three)", 8, "y2i("),
    ("one two", 0, "vwy"), ("one\ntwo\nthree", 0, "Vjy"),
    ("one two", 1, "viwy"), ("one two", 0, "vlloy"),
    ("one two one", 0, "*"), ("one two one", 8, "#"),
    ("one ones one", 0, "g*"), ("one two one", 0, "*N"),
    ("one\ntwo\none", 0, "*"),
    ("one\ntwo\n\nthree", 0, "}"), ("one\ntwo\n\nthree", 9, "{"),
    ("one\ntwo", 0, "}"), ("one\ntwo", 0, "y}"),
    ("a e\u0301 b", 0, "fe"), ("one\ntwo\nthree", 0, "2$"),
    ("a\naz", 0, "fzj;"),
]

def vim_string(value):
    return json.dumps(value, ensure_ascii=False)

with tempfile.TemporaryDirectory(prefix="vim-transcript-reference-") as directory:
    out = Path(directory) / "expected.jsonl"
    commands = ["set nocompatible encoding=utf-8 nomore", "set iskeyword=@,48-57,_,192-255", f"call writefile([], {vim_string(str(out))})"]
    for text, at, strokes in cases:
        row = text[:at].count("\n") + 1
        column = len(text[:at].rsplit("\n", 1)[-1].encode()) + 1
        commands += ['execute "normal! \\<Esc>"', "enew!", "call setline(1, " + json.dumps(text.split("\n")) + ")", f"call cursor({row}, {column})", "call feedkeys(" + vim_string(strokes) + ", 'xt')", 'call writefile([json_encode({"row":line("."),"col":col("."),"yank":getreg(),"kind":getregtype()})], ' + vim_string(str(out)) + ', "a")']
    commands.append("qa!")
    subprocess.run(["vim", "-Nu", "NONE", "-i", "NONE", "-n", "-es", "-S", "/dev/stdin"], input="\n".join(commands), text=True, check=True)
    expected = []
    for case, line in zip(cases, out.read_text().splitlines()):
        item = json.loads(line)
        row = case[0].split("\n")[item["row"] - 1]
        item["caret"] = len(row.encode()[:item["col"] - 1].decode().encode("utf-16-le")) // 2
        if item["kind"] == "V":
            item["yank"] = item["yank"].removesuffix("\n")
        expected.append(item)

source = r'''//! Exercise read-only transcript commands and source anchors through the real root.
import apply from PLUGIN;
import { ChatView, Transcript } from "yuke:chat";
import { Session } from "yuke:session";
import { quit } from "yuke:ui";
/** Run isolated transcript invariants. No TUI skips the probe. Failures are reported. @param {import("yuke").Context} ctx */
export default function(ctx) {
 apply(ctx); const tui=ctx.get("tui"); if(!tui) return;
 ctx.once("ui.started", async () => { try {
  const root=tui.root, view=root.active; if(!(view instanceof ChatView)) throw Error("missing chat");
  function check(actual,want,label) { if(JSON.stringify(actual)!==JSON.stringify(want)) throw Error(label+": "+JSON.stringify(actual)+" != "+JSON.stringify(want)); }
  function key(char,mods=0,code="char") { root.onEvent({type:"key",event:"press",code,char,text:mods?"":char,mods,shifted:"",baseLayout:""}); }
  function feed(strokes) { for(const ch of strokes) key(ch); }
  function fixture(pane,text,width=80) {
   const part={id:7,type:"text",text:"```text\n"+text+"\n```"};
   pane.transcript=new Transcript({partsOf:()=>[part]}); pane.transcript.setOutline([{id:101,type:"assistant"}],null); pane.transcript.rows(width,0,1000);
   return part;
  }
  let copied=""; ctx.on("clipboard.copied",ev=>{copied=ev.text;});
  view.composer.input.setText("KEEP");
  const cases=CASES, expected=EXPECTED;
  for(let n=0;n<cases.length;n++) {
   const [text,at,strokes]=cases[n]; view.focusRegion("composer"); fixture(view,text); view.focusRegion("transcript"); feed("gg");
   const before=text.slice(0,at), row=before.split("\n").length-1, col=before.slice(before.lastIndexOf("\n")+1).length;
   for(let i=0;i<row;i++) key("j"); for(let i=0;i<col;i++) key("l");
   copied=""; feed(strokes);
   check({row:view.transcript.caret?.row,col:view.transcript.caret?.col},{row:expected[n].row-1,col:expected[n].caret},"case "+n+" "+strokes);
   if(strokes.includes("y")) check(copied,expected[n].yank,"yank "+n);
   check(view.composer.input.text,"KEEP","read-only composer "+n);
  }
  view.focusRegion("composer"); const part=fixture(view,"  alpha 👩‍💻 beta\nsecond row\nthird row",24); view.focusRegion("transcript"); feed("gg^wma");
  view.transcript.setOutline([], {id:101,type:"assistant"}); view.transcript.rows(24,0,1000);
  const marked=view.transcript.sourceAt(view.transcript.caret);
  feed("G`a"); check(view.transcript.sourceAt(view.transcript.caret),marked,"mark exact");
  feed("G'a"); check(view.transcript.caret?.col,2,"mark row start");
  view.transcript.rows(12,0,1000); feed("G`a"); check(view.transcript.sourceAt(view.transcript.caret),marked,"mark rewrap");
  part.text=part.text.replace("third row","third row appended"); view.transcript.setActive(101,7); view.transcript.rows(12,0,1000); feed("G`a");
  check(view.transcript.sourceAt(view.transcript.caret),marked,"mark appended text");
  const same=new ChatView(view.session); fixture(same,"  alpha 👩‍💻 beta\nsecond row\nthird row",12);
  if(!tui.split("row",same)) throw Error("split"); same.focusRegion("transcript"); feed("gg`a"); check(same.transcript.sourceAt(same.transcript.caret),marked,"same-session mark");
  const other=new ChatView(new Session()); fixture(other,"  alpha 👩‍💻 beta\nsecond row\nthird row",12);
  if(!tui.split("col",other)) throw Error("split other"); other.focusRegion("transcript"); feed("gg"); const untouched=other.transcript.caret; feed("`a"); check(other.transcript.caret,untouched,"different-session mark");
  root.focusView(view); view.focusRegion("transcript"); feed("gg");
  part.text="```text\nchanged prefix\nsecond row\nthird row\n```"; view.transcript.setActive(101,7); view.transcript.rows(12,0,1000); feed("gg"); const missing=view.transcript.caret; feed("`a"); check(view.transcript.caret,missing,"changed mark target");
  view.focusRegion("composer");
  const headings=[
   {id:1,type:"tool",name:"exec",arguments:'{"command":"above"}',state:{type:"completed",output:"above output"}},
   {id:2,type:"reasoning",text:"hidden body",title:"my thought",duration_ms:1000},
   {id:3,type:"tool",name:"exec",arguments:'{"command":"target"}',state:{type:"completed",output:"target output"}},
  ];
  view.transcript=new Transcript({partsOf:()=>headings}); const titles=view.transcript;
  titles.setOutline([], {id:202,type:"assistant"}); titles.rows(48,0,1000); view.focusRegion("transcript");
  function header(partId) {const pos=titles.partHeader(202,partId);if(!pos)throw Error("header absent");feed("gg");for(let row=0;row<pos.row;row++)key("j");}
  header(2); feed("lmt"); header(3); feed("lms");
  titles.togglePart(202,1); titles.rows(48,0,1000); feed("G`t"); check(titles.partAt(titles.caret)?.partId,2,"thought header after fold above"); check(titles.caret?.col,1,"thought header column");
  titles.rows(16,0,1000); feed("G`s"); check(titles.partAt(titles.caret)?.partId,3,"tool header after resize");
  headings[1].duration_ms=123456; headings[1].title="changed title"; titles.setActive(202,2); titles.rows(16,0,1000); feed("G`t"); check(titles.partAt(titles.caret)?.partId,2,"updated thought header");
  feed("G't"); check(titles.caret?.col,0,"thought row-start mark");
  headings.shift(); titles.setActive(202); titles.rows(16,0,1000); feed("G`s"); check(titles.partAt(titles.caret)?.partId,3,"header after removal above");
  headings.pop(); titles.setActive(202); titles.rows(16,0,1000); feed("gg"); const removed=titles.caret; feed("`s"); check(titles.caret,removed,"removed tool header");
  const ungroup=ctx.get("chat").render({groupKey:part=>part.type==="text"?null:"marks-test",groupHeader:group=>[{text:group.count+" actions",group:"TxMeta"}]});
  titles.rows(16,0,1000); feed("ggmg"); headings.push({id:4,type:"tool",name:"exec",arguments:'{"command":"new"}',state:{type:"completed",output:"new output"}}); titles.setActive(202); titles.rows(16,0,1000); feed("G`g"); check(titles.rowTextAt(202,titles.caret.row),"2 actions","updated group header mark");
  ungroup();
  view.focusRegion("composer"); fixture(view,"one\ntwo\nthree"); view.focusRegion("transcript"); feed("ggVj"); check(view.transcript.selectedText(false),"one\ntwo","visual lines");
  key("",0,"esc"); feed("gv"); check(view.transcript.selectedText(false),"one\ntwo","restore visual lines"); feed("y");
  view.focusRegion("composer"); tui.command.perform("vim-mode:normal"); view.composer.input.setText("X"); view.composer.input.caret=0; feed("p"); check(view.composer.input.text,"X\none\ntwo","linewise register");
  view.focusRegion("transcript"); feed("ggf"); key("",0,"esc"); feed("l"); check(view.transcript.caret?.col,1,"cancel find");
  feed("f"); view.focusRegion("composer"); view.focusRegion("transcript"); feed("l"); check(view.transcript.caret?.col,2,"focus cancels find");
  view.focusRegion("composer"); fixture(view,"one two one\nother two"); view.focusRegion("transcript"); feed("gg"); key("/",2);
  feed("two"); key("",0,"enter"); await Promise.resolve(); await Promise.resolve(); check(view.transcript.caret?.col,4,"search dialog");
  feed("n"); check(view.transcript.caret?.row,1,"search next row"); feed("N"); check(view.transcript.caret?.row,0,"search reverse");
  key("/",2); key("",0,"esc"); await Promise.resolve(); await Promise.resolve(); check(view.transcript.caret?.col,4,"search cancel");
  ctx.print("TRANSCRIPT "+cases.length+" Vim cases; source and header marks, session isolation, visual lines, cancellation, and search passed");
 } catch(error) {ctx.print("VIM_FAIL "+String(error));} quit(); });
}
'''.replace("PLUGIN", json.dumps(str(plugin))).replace("CASES", json.dumps(cases)).replace("EXPECTED", json.dumps(expected))
logs = run(source, timeout=60, uses=("tui", "chat"))
print(next(line for line in logs.splitlines() if "TRANSCRIPT " in line))
