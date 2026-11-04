#!/usr/bin/env python3
"""Load the Vim manifest in a real terminal with an isolated Yuke profile."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time

package = Path(__file__).resolve().parents[1]
binary = shutil.which(os.environ.get("YUKE_BINARY", "yuke"))
if binary is None:
    raise SystemExit("Set YUKE_BINARY to the Yuke executable")
width, height = 80, 24
transcript = bytearray()
control = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")

with tempfile.TemporaryDirectory(prefix="yuke-vim-terminal-") as directory:
    root = Path(directory)
    config = root / "config/yuke"
    config.mkdir(parents=True)
    (root / "work").mkdir()
    ready = root / "mounted.txt"
    navigation = root / "navigation.json"
    probe = root / "probe"
    probe.mkdir()
    (probe / "plugin.json").write_text(json.dumps({"name": "vim-probe", "extensions": {"sh.yuke": {"entry": "index.ts"}}}))
    (probe / "index.ts").write_text('''import { writeTextFile } from "yuke:fs";
import { TextEditor, TextView } from "yuke:tui";
export function apply(ctx) {
  const tui = ctx.get("tui");
  if (tui === undefined) return;
  let recorded = false;
  tui.widgets.watch((mount) => {
    if (recorded || mount.widget.kind !== "editor" || mount.widget.role !== "composer") return;
    recorded = true;
    void writeTextFile(READY, "mounted\\n", { append: true }).catch((error) => ctx.notify("error", String(error)));
  });
  tui.commands.add({ name: "transcript", run: () => {
    const group = {};
    const editor = new TextEditor({ role: "composer", group });
    const view = new TextView({ role: "transcript", group, document: {
      key: "terminal-fixture", items: [{ key: "reply", sections: [{ key: "body", kind: "text", text: "alpha beta gamma" }] }],
    } });
    editor.extend(ctx.signal).onChange(() => {
      void writeTextFile(NAVIGATION, JSON.stringify({ text: editor.state.text, focused: tui.focused === editor }))
        .catch((error) => ctx.notify("error", String(error)));
    });
    tui.panes.split(() => ({ initialFocus: editor, draw() {}, layout: (size) => [
      { view, rect: { column: 0, row: 0, width: size.width, height: size.height - 2 } },
      { view: editor, rect: { column: 0, row: size.height - 2, width: size.width, height: 2 } },
    ] }));
  } });
}
'''.replace("READY", json.dumps(str(ready))).replace("NAVIGATION", json.dumps(str(navigation))))
    (config / "config.json").write_text(json.dumps({"plugins": [str(package), str(probe)]}))
    environment = dict(
        os.environ, HOME=str(root), YUKE_APPNAME="yuke", XDG_CONFIG_HOME=str(root / "config"),
        XDG_DATA_HOME=str(root / "data"), XDG_CACHE_HOME=str(root / "cache"),
        TERM="xterm-256color", COLORTERM="truecolor",
    )
    process, terminal = pty.fork()
    if process == 0:
        os.chdir(root / "work")
        os.execve(binary, [binary], environment)
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))

    def pump():
        ready, _, _ = select.select([terminal], [], [], 0.05)
        if ready:
            data = os.read(terminal, 65536)
            transcript.extend(data)
            if b"\x1b]11;?" in data:
                os.write(terminal, b"\x1b]11;rgb:1111/1111/1111\x1b\\\x1b[?0u\x1b[?62c")

    def screen():
        cells = [[" "] * width for _ in range(height)]
        row = column = offset = 0
        text = transcript.decode(errors="replace")
        while offset < len(text):
            character = text[offset]
            if character == "\x1b":
                match = control.match(text, offset)
                if match is None:
                    break
                sequence = match.group()
                if sequence.startswith("\x1b["):
                    if sequence.endswith("H"):
                        coordinates = sequence[2:-1].split(";")
                        row = int(coordinates[0] or "1") - 1
                        column = int(coordinates[1] or "1") - 1 if len(coordinates) > 1 else 0
                    elif sequence.endswith("J") and sequence[2:-1] in ("", "2", "3"):
                        cells = [[" "] * width for _ in range(height)]
                offset = match.end()
                continue
            if character == "\r":
                column = 0
            elif character == "\n":
                row += 1
            elif character >= " ":
                if 0 <= row < height and 0 <= column < width:
                    cells[row][column] = character
                column += 1
            offset += 1
        return ["".join(line).rstrip() for line in cells]

    def wait_for(predicate):
        deadline = time.monotonic() + 10
        while not predicate(screen()):
            if time.monotonic() >= deadline:
                raise AssertionError("\n".join(screen()))
            pump()

    def contains(value):
        return lambda rows: any(value in row for row in rows)

    try:
        wait_for(contains("INSERT"))
        os.write(terminal, b"alpha beta gamma")
        wait_for(contains("alpha beta gamma"))
        os.write(terminal, b"\x1b")
        wait_for(contains("NORMAL"))
        os.write(terminal, b"0dw")
        wait_for(lambda rows: any(row.strip() == "beta gamma" for row in rows))
        os.write(terminal, b"u")
        wait_for(contains("alpha beta gamma"))
        os.write(terminal, b"0ciwHELLO\x1b")
        wait_for(contains("HELLO beta gamma"))
        wait_for(contains("NORMAL"))
        os.write(terminal, b"\x03")
        wait_for(contains("Message"))
        os.write(terminal, b"i")
        wait_for(contains("INSERT"))
        wait_for(lambda rows: ready.exists())
        mounts = ready.read_text().count("mounted\n")
        os.write(terminal, b"/reload\r")
        # A public widget mount callback acknowledges the new runtime.
        wait_for(lambda rows: ready.read_text().count("mounted\n") > mounts and contains("INSERT")(rows) and contains("Message")(rows))
        os.write(terminal, b"after reload")
        wait_for(contains("after reload"))
        os.write(terminal, b"\x1b")
        wait_for(contains("NORMAL"))
        os.write(terminal, b"0dw")
        wait_for(lambda rows: any(row.strip() == "reload" for row in rows))
        os.write(terminal, b"\x03")
        wait_for(contains("Message"))
        os.write(terminal, b"/vim-probe:transcript\r")
        wait_for(contains("alpha beta gamma"))
        os.write(terminal, b"\x1b")
        wait_for(contains("NORMAL"))
        os.write(terminal, b"\tgg02yw\tp")
        def copied_to_composer(_rows):
            if not navigation.exists():
                return False
            try:
                return json.loads(navigation.read_text()) == {"text": "alpha beta ", "focused": True}
            except json.JSONDecodeError:
                return False
        wait_for(copied_to_composer)
        print("PASS real terminal: editing, undo, text object, reload, transcript focus, and shared registers")
    finally:
        Path(os.environ.get("YUKE_VIM_TERMINAL_LOG", "/tmp/yuke-vim-terminal.log")).write_bytes(transcript)
        os.kill(process, signal.SIGTERM)
        os.waitpid(process, 0)
        os.close(terminal)
