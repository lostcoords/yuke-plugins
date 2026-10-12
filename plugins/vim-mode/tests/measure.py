#!/usr/bin/env python3
"""Compare actual profile input and cached draw. Heap deltas are not cumulative allocation counts."""
import argparse
import json
from pathlib import Path
import statistics
from support import run

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--base", type=Path, required=True)
parser.add_argument("--runs", type=int, default=6)
parser.add_argument("--iterations", type=int, default=30000)
parser.add_argument("--phase", choices=["motion", "long_ascii", "long_unicode", "typing", "draw", "edit", "visual_draw", "frame"])
parser.add_argument("--callgrind", type=Path)
parser.add_argument("--binary", default="yuke")
args = parser.parse_args()
head = Path(__file__).resolve().parents[1]
source = r'''//! Measure the plugin through real root dispatch, without desktop input.
import apply from PLUGIN;
import { ChatView } from "yuke:chat";
import { client } from "yuke";
import { quit } from "yuke:ui";
/** Run isolated input workloads. No TUI skips the probe. A missing pane fails. @param {import("yuke").Context} ctx */
export default function(ctx) {
 apply(ctx); const tui = ctx.get("tui"); if (!tui) return;
 ctx.once("ui.started", () => {
  const view = tui.root.active; if (!(view instanceof ChatView)) throw Error("missing chat");
  const c = view.composer, root = tui.root;
  function ev(char, code="char") { return {type:"key",event:"press",code,char,text:char,mods:0,shifted:"",baseLayout:""}; }
  const w=ev("w"), b=ev("b"), x=ev("X"), backspace=ev("","backspace"), i=ev("i"), esc=ev("","esc"), v=ev("v"), l=ev("l");
  c.layout({x:0,y:0,w:80,h:6});
  function motion() { root.onEvent(w); root.onEvent(b); }
  function typing() { root.onEvent(x); root.onEvent(backspace); }
  function draw() { c.draw(true); }
  function frame() { root.invalidatePaint(); root.draw(); }
  function edit() { tui.command.perform("vim-mode:normal"); c.input.setText("alpha beta"); c.input.caret=0; root.onEvent(i); root.onEvent(x); root.onEvent(esc); }
  function measure(name, step, iterations) {
   for(let n=0;n<300;n++) step();
   const before=client.memoryUsage(), start=Date.now();
   for(let n=0;n<iterations;n++) step();
   const ms=Date.now()-start, after=client.memoryUsage();
   ctx.print("BENCH " + JSON.stringify({name,iterations,ms,heapDelta:after.heap-before.heap,objects:after.objectCount-before.objectCount,arrays:after.arrayCount-before.arrayCount}));
  }
  const phases=PHASES;
  for(let n=0;n<phases.length;n++) {
   const phase=phases[n];
   tui.command.perform("vim-mode:normal"); c.input.setText(phase==="long_ascii"?"alpha beta ".repeat(1000):phase==="long_unicode"?"alpha 中文かな next ".repeat(1000):"alpha beta"); c.input.caret=0;
   if(phase==="typing") tui.command.perform("vim-mode:insert");
   if(phase==="visual_draw") { root.onEvent(v); root.onEvent(l); }
   measure(phase, phase==="typing"?typing:phase==="draw"||phase==="visual_draw"?draw:phase==="edit"?edit:phase==="frame"?frame:motion, phase.startsWith("long_")?Math.max(1,Math.floor(ITERATIONS/20)):ITERATIONS);
  }
  quit();
 });
}
'''
phases = [args.phase] if args.phase else ["motion", "long_ascii", "long_unicode", "typing", "draw", "edit", "frame"]
results = {"base": {}, "head": {}}
for trial in range(args.runs):
    for side in (["base", "head"] if trial % 2 == 0 else ["head", "base"]):
        plugin = (args.base if side == "base" else head) / "index.js"
        script = source.replace("PLUGIN", json.dumps(str(plugin.resolve()))).replace("PHASES", json.dumps(phases)).replace("ITERATIONS", str(args.iterations))
        command = [args.binary]
        if args.callgrind:
            args.callgrind.mkdir(parents=True, exist_ok=True)
            command = ["valgrind", "--tool=callgrind", "--quiet", "--callgrind-out-file=" + str((args.callgrind / f"{side}-{args.iterations}-{trial}.cg").resolve()), args.binary]
        logs = run(script, timeout=240, command=command)
        for line in logs.splitlines():
            if "BENCH " in line:
                item = json.loads(line.split("BENCH ", 1)[1])
                results[side].setdefault(item["name"], []).append(item)
        print(f"{side} run {trial + 1}: " + ", ".join(f"{v[-1]['name']}={v[-1]['ms']}ms" for v in results[side].values()), flush=True)
for phase in phases:
    low = {}
    for side in results:
        values = results[side][phase]
        low[side] = statistics.mean(sorted(v["ms"] for v in values)[:max(1, (args.runs + 3) // 4)])
    delta = (low["head"] / low["base"] - 1) * 100 if low["base"] else 0
    print(f"{phase}: base={low['base']:.1f}ms head={low['head']:.1f}ms delta={delta:+.1f}%")
    print("  retained heap deltas:", {side: [v["heapDelta"] for v in results[side][phase]] for side in results})
print("Wall time has noise. Heap deltas do not count cumulative allocations.")
