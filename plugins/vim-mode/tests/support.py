#!/usr/bin/env python3
"""Run a profile probe in an isolated terminal, store, and workspace."""
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


def run(source, timeout=30, command=None, uses=("tui",)):
    binary = shutil.which("yuke")
    if not binary:
        raise RuntimeError("yuke is not on PATH")
    with tempfile.TemporaryDirectory(prefix="yuke-vim-probe-") as directory:
        root = Path(directory)
        profile = root / "config/yuke"
        plugin = profile / "probe"
        plugin.mkdir(parents=True)
        (profile / "config.json").write_text(json.dumps({"plugins": ["./probe"]}))
        (plugin / "plugin.json").write_text(json.dumps({"name": "vim-mode", "extensions": {"sh.yuke": {"entry": "./index.js", "uses": list(uses)}}}))
        (plugin / "index.js").write_text(source)
        env = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"), XDG_STATE_HOME=str(root / "state"), YUKE_APPNAME="yuke", TERM="xterm-256color")
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(directory)
            args = (command or [binary])
            os.execvpe(args[0], args, env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        output = bytearray()
        deadline = time.monotonic() + timeout
        status = None
        try:
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.05)[0]:
                    try:
                        output.extend(os.read(fd, 65536))
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                done, result = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = os.waitstatus_to_exitcode(result)
                    break
            if status is None:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            logs = "\n".join(path.read_text(errors="replace") for path in (root / "state").rglob("*.log"))
            if status != 0 or "VIM_FAIL" in logs or "[error]" in logs:
                raise RuntimeError(f"probe status {status}\n{logs}\n{output.decode(errors='replace')[-2000:]}")
            return logs
        finally:
            os.close(fd)
