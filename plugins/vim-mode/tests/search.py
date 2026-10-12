#!/usr/bin/env python3
"""Drive the real draft-search dialog without desktop input."""
import json
from pathlib import Path
from support import run

plugin = Path(__file__).resolve().parents[1] / "index.js"
source = r'''//! Search dialog, repeat, operator, and stale-answer invariants.
import apply from PLUGIN;
import { ChatView } from "yuke:chat";
import { quit } from "yuke:ui";
/** Run isolated modal checks. No TUI skips the probe. Invariant failures are reported. @param {import("yuke").Context} ctx */
export default function(ctx) {
 apply(ctx); const tui=ctx.get("tui"); if(!tui) return;
 ctx.once("ui.started", async () => {
  try {
   const root=tui.root, view=root.active; if(!(view instanceof ChatView)) throw Error("missing pane");
   const c=view.composer;
   function key(char,mods=0,code="char") { root.onEvent({type:"key",event:"press",code,char,text:mods?"":char,mods,shifted:"",baseLayout:""}); }
   function check(want) { if(c.input.caret!==want) throw Error("caret "+c.input.caret+" != "+want); }
   async function answer(value) { for(let i=0;i<value.length;i++) key(value[i]); key("",0,"enter"); await Promise.resolve(); await Promise.resolve(); }
   tui.command.perform("vim-mode:normal"); c.input.setText("one two one two"); c.input.caret=0;
   key("/",2); await answer("two"); check(4);
   key("n"); check(12); key("N"); check(4); key("2"); key("n"); check(4);
   key("d"); key("n"); if(c.input.text!=="one two") throw Error("dn range");
   c.input.setText("one two one two"); c.input.caret=0;
   key("/",2); key("",0,"esc"); await Promise.resolve(); await Promise.resolve(); check(0);
   key("/",2); c.input.setText("new draft"); c.input.caret=0; await answer(""); check(0);
   c.input.setText("one two one two"); c.input.caret=0;
   key("/",2); view.focusRegion("transcript"); await answer(""); check(0);
   ctx.print("SEARCH dialog, repeat, operator, cancel, and stale-answer checks passed");
  } catch(error) { ctx.print("VIM_FAIL "+String(error)); }
  quit();
 });
}
'''.replace("PLUGIN", json.dumps(str(plugin)))
logs = run(source)
print(next(line for line in logs.splitlines() if "SEARCH " in line))
