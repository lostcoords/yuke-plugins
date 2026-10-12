#!/usr/bin/env python3
"""Run the Vim invariants in a real Yuke terminal with an isolated profile and database."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import tempfile
import termios
import time

package = Path(__file__).resolve().parents[1]
binary = shutil.which("yuke")
if binary is None:
    raise SystemExit("yuke is not on PATH")

with tempfile.TemporaryDirectory(prefix="yuke-vim-mode-") as tmp:
    root = Path(tmp)
    profile = root / "config/yuke"
    profile.mkdir(parents=True)
    (profile / "config.json").write_text(json.dumps({"plugins": [str(package / "tests")]}))
    env = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"),
               XDG_DATA_HOME=str(root / "data"), XDG_STATE_HOME=str(root / "state"),
               YUKE_APPNAME="yuke", TERM="xterm-256color")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(tmp)
        os.execve(binary, [binary], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    output = bytearray()
    deadline = time.monotonic() + 20
    status = None
    try:
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.05)[0]:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                output.extend(chunk)
                if chunk:
                    continue
            done, result = os.waitpid(pid, os.WNOHANG)
            if done:
                status = os.waitstatus_to_exitcode(result)
                break
        if status is None:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
            print(output.decode(errors="replace"))
            for log in (root / "state").rglob("*.log"):
                print(log.read_text(errors="replace"))
            raise SystemExit("Vim checks timed out. An assertion did not reach quit().")
        if status != 0:
            print(output.decode(errors="replace"))
            raise SystemExit(f"Yuke exited {status}")
        print("vim-mode: real-terminal key, Unicode, shared-register, and cleanup checks passed")
    finally:
        os.close(fd)
