#!/usr/bin/env python3
"""Check Solarized in private native terminals without models or desktop input."""
import argparse
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
import subprocess
import tempfile
import termios
import time

EXPECTED = {
    'truecolor': {
        'dark': {'fg': '#adbcbc', 'bg': '#082b34', 'accent': '#4695f7', 'violet': '#b7a2e8', 'userBg': '#28434d', 'userFg': '#eee8d5'},
        'light': {'fg': '#405157', 'bg': '#fdf6e3', 'accent': '#006599', 'violet': '#724b9e', 'userBg': '#d4e2df', 'userFg': '#304147'},
    },
    '256': {
        'dark': {'fg': 248, 'bg': 234, 'accent': 75, 'violet': 183, 'userBg': 237, 'userFg': 230},
        'light': {'fg': 239, 'bg': 230, 'accent': 24, 'violet': 60, 'userBg': 152, 'userFg': 237},
    },
}
OVERRIDE = '''//! Override one theme group and palette color through public owned APIs.
/** Register an independent style override. No TUI skips it. Registration failures throw. @param {import("yuke").Context} ctx */
export default function(ctx) {
  const tui = ctx.get("tui");
  if (!tui) return;
  tui.style.set({ TxThought: { fg: "#112233", bold: true } });
  tui.style.setPalette({ accent: "#abcdef" });
}
'''


def manifest(name):
    return {'name': name, 'extensions': {'sh.yuke': {'entry': './index.js', 'uses': ['tui']}}}


def check(row, colors, background, overridden):
    assert row['colors'] == colors and row['background'] == background, row
    for key, value in EXPECTED[colors][background].items():
        assert row['palette'][key] == ('#abcdef' if overridden and key == 'accent' else value), (key, row)
    assert row['thought']['fg'] == ('#112233' if overridden else EXPECTED[colors][background]['violet']), row
    assert row['thought'].get('italic') is True and not row['thought'].get('dim'), row
    assert row['thought'].get('bold', False) == overridden, row
    assert row['user']['fg'] == EXPECTED[colors][background]['userFg'], row
    assert row['user']['bg'] == EXPECTED[colors][background]['userBg'], row
    assert row['heading']['fg'] == row['palette']['accent'] and row['heading']['bold'], row
    assert row['panel']['fg'] == row['palette']['fg'] and row['panel']['bg'] == row['palette']['bg'], row


class Terminal:
    def __init__(self, binary, case, env):
        self.case = case
        self.output = bytearray()
        self.status = None
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(case / 'work')
            os.execve(binary, [str(binary)], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

    def rows(self):
        rows = []
        for log in (self.case / 'state').rglob('*.log'):
            for line in log.read_text(errors='replace').splitlines():
                if 'SOLARIZED_SNAPSHOT ' in line:
                    rows.append(json.loads(line.split('SOLARIZED_SNAPSHOT ', 1)[1]))
        return rows

    def wait(self, predicate, label):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], .05)[0]:
                try:
                    data = os.read(self.fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b''
                self.output.extend(data)
            rows = self.rows()
            result = predicate(rows)
            if result:
                return result
            done, status = os.waitpid(self.pid, os.WNOHANG)
            if done:
                self.status = os.waitstatus_to_exitcode(status)
                raise AssertionError(label + ': native process exited ' + str(self.status))
        raise AssertionError(label + ': timed out; read ' + str(self.case))

    def background(self, name):
        value = 'ffff/ffff/ffff' if name == 'light' else '0000/0000/0000'
        os.write(self.fd, ('\x1b]11;rgb:' + value + '\x1b\\').encode())

    def close(self):
        try:
            if self.status is None:
                os.write(self.fd, b'\x11')
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if select.select([self.fd], [], [], .05)[0]:
                        try:
                            self.output.extend(os.read(self.fd, 65536))
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                    done, status = os.waitpid(self.pid, os.WNOHANG)
                    if done:
                        self.status = os.waitstatus_to_exitcode(status)
                        break
                if self.status is None:
                    os.kill(self.pid, signal.SIGKILL)
                    os.waitpid(self.pid, 0)
                    raise AssertionError('Native terminal did not stop')
                assert self.status == 0, self.status
        finally:
            (self.case / 'terminal.ansi').write_bytes(self.output)
            os.close(self.fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path(shutil.which('yuke') or 'yuke'))
    parser.add_argument('--plugin', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    source = args.plugin.resolve(strict=True)
    probe_source = Path(__file__).with_name('probe.js').read_text()
    root = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='yuke-solarized-')).resolve()
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    print('Artifacts:', root, flush=True)
    results = []
    for colors, order in [('truecolor', 'none'), ('256', 'none'), ('truecolor', 'before'), ('truecolor', 'after')]:
        case = root / (colors + '-' + order)
        for folder in ('home', 'work', 'config/yuke', 'data', 'state', 'cache'):
            (case / folder).mkdir(parents=True)
        profile = case / 'config/yuke'
        shutil.copytree(source, profile / 'theme', ignore=shutil.ignore_patterns('tests', '__pycache__'))
        for name, code in [('probe', probe_source), ('override', OVERRIDE)]:
            folder = profile / name
            folder.mkdir()
            (folder / 'plugin.json').write_text(json.dumps(manifest(name)))
            (folder / 'index.js').write_text(code)
        entries = ['./probe', './theme']
        if order != 'none':
            entries.insert(1 if order == 'before' else 2, './override')
        def config(themed):
            (profile / 'config.json').write_text(json.dumps({'tui': {'colors': colors, 'mouse': {'copyOnSelect': False}}, 'plugins': entries if themed else [entry for entry in entries if entry != './theme']}))
        config(True)
        env = {'HOME': str(case / 'home'), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'YUKE_APPNAME': 'yuke'}
        for folder in ('config', 'data', 'state', 'cache'):
            env['XDG_' + folder.upper() + '_HOME'] = str(case / folder)
        run = subprocess.run([str(binary), 'check'], cwd=case / 'work', env=env, capture_output=True, text=True, timeout=30)
        (case / 'startup.log').write_text(run.stdout + run.stderr)
        assert run.returncode == 0 and '0 error(s), 0 warning(s)' in run.stdout + run.stderr, run.stderr
        (profile / 'probe/generation.json').unlink(missing_ok=True)
        terminal = Terminal(binary, case, env)
        try:
            row = terminal.wait(lambda rows: next((r for r in reversed(rows) if r['generation'] == 1 and r['background'] == 'dark'), None), 'initial dark theme')
            check(row, colors, 'dark', order != 'none')
            terminal.background('light')
            row = terminal.wait(lambda rows: next((r for r in reversed(rows) if r['generation'] == 1 and r['background'] == 'light'), None), 'live light switch')
            check(row, colors, 'light', order != 'none')
            terminal.background('dark')
            row = terminal.wait(lambda rows: next((r for r in reversed(rows) if r['generation'] == 1 and r['background'] == 'dark' and r is rows[-1]), None), 'live dark switch')
            check(row, colors, 'dark', order != 'none')
            config(False)
            os.write(terminal.fd, b'\x07')
            row = terminal.wait(lambda rows: next((r for r in reversed(rows) if r['generation'] == 2), None), 'reload without theme')
            assert 'violet' not in row['palette'] and 'userBg' not in row['palette'], row
            assert row['thought'].get('dim') is True and row['thought']['fg'] == ('#112233' if order != 'none' else 'reset'), row
            assert row['palette']['accent'] == ('#abcdef' if order != 'none' else '#A8CFA0' if colors == 'truecolor' else 151), row
            previous = len(terminal.rows())
            terminal.background('light')
            terminal.wait(lambda rows: rows[-1] if len(rows) > previous and rows[-1]['generation'] == 2 and rows[-1]['background'] == 'light' else None, 'background change after theme removal')
            assert len(terminal.rows()) == previous + 1, 'Old probe listener survived reload'
            config(True)
            os.write(terminal.fd, b'\x07')
            row = terminal.wait(lambda rows: next((r for r in reversed(rows) if r['generation'] == 3), None), 'reload with theme restored')
            check(row, colors, row['background'], order != 'none')
        finally:
            terminal.close()
        logs = '\n'.join(p.read_text(errors='replace') for p in (case / 'state').rglob('*.log'))
        assert '[error]' not in logs, logs
        run = subprocess.run([str(binary), '--rpc'], input='{"id":"theme-check","method":"initialize","params":{}}\n', cwd=case / 'work', env=env, capture_output=True, text=True, timeout=30)
        (case / 'headless.log').write_text(run.stdout + run.stderr)
        records = [json.loads(line) for line in run.stdout.splitlines() if line.startswith('{')]
        assert run.returncode == 0 and any(row.get('id') == 'theme-check' and 'result' in row for row in records), run.stderr
        assert '[error]' not in run.stderr, run.stderr
        results.append({'colors': colors, 'override': order, 'passed': True})
        print('PASS', colors, order, 'palettes, live background, overrides, removal, reload, headless, and shutdown', flush=True)
    (root / 'results.json').write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
