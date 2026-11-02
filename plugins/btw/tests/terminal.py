import copy
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import termios
import threading
import time

PLUGIN = Path(__file__).resolve().parent.parent
YUKE = shutil.which('yuke')


def scenario(width, height, light, inline, resume, main_running=True, cancel_side=False):
    requests = []
    release = threading.Event()
    release_side = threading.Event()
    side_closed = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            index = len(requests)
            requests.append(body)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            text = ['SEED ANSWER', 'MAIN WORKING', 'SIDE ANSWER OK'][index]
            events = [
                {'type': 'message_start', 'message': {'usage': {'input_tokens': 1}}},
                {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}},
            ]
            try:
                for event in events:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
                if index == 1:
                    release.wait(20)
                elif index == 2:
                    deadline = time.monotonic() + 20
                    while not release_side.wait(0.05) and time.monotonic() < deadline:
                        readable, _, _ = select.select([self.connection], [], [], 0)
                        if readable and self.connection.recv(1, socket.MSG_PEEK) == b'':
                            side_closed.set()
                            return
                for event in [
                    {'type': 'content_block_stop', 'index': 0},
                    {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 3}},
                    {'type': 'message_stop'},
                ]:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    pid = None
    transcript = bytearray()
    try:
        with tempfile.TemporaryDirectory(prefix='yuke-btw-pty-') as root:
            root = Path(root)
            config = root / 'config/yuke'
            config.mkdir(parents=True)
            (root / 'work').mkdir()
            (config / 'config.json').write_text(json.dumps({'plugins': [str(PLUGIN)]}))
            (config / 'providers.json').write_text(json.dumps({'providers': [{
                'id': 'local', 'base_url': f'http://127.0.0.1:{server.server_port}/v1',
                'endpoints': [{'protocol': 'anthropic_messages', 'cache_breakpoint': True}],
                'models': [{'id': 'small', 'flags': {'supports_cache_breakpoint': True}, 'limits': {'context_window': 64000, 'max_output_tokens': 4096}}],
            }]}))
            env = dict(os.environ, HOME=str(root), XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'), XDG_CACHE_HOME=str(root / 'cache'), TERM='xterm-256color', COLORTERM='truecolor')
            seeded = subprocess.run([YUKE, '-p', 'seed task', '--model', 'local/small', '--reasoning', 'default'], env=env, cwd=root / 'work', capture_output=True, timeout=15)
            assert seeded.returncode == 0, seeded.stderr.decode()
            (root / 'data/yuke/plugins/chat/choice.json').write_text(json.dumps({'model': {'provider': 'local', 'model': 'small'}, 'reasoning': 'default'}))
            pid, master = pty.fork()
            if pid == 0:
                os.chdir(root / 'work')
                os.execve(YUKE, [YUKE] + (['-c'] if resume else []), env)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))

            def pump(seconds=0.1):
                end = time.monotonic() + seconds
                while time.monotonic() < end:
                    ready, _, _ = select.select([master], [], [], min(0.05, max(0, end - time.monotonic())))
                    if not ready:
                        continue
                    data = os.read(master, 65536)
                    transcript.extend(data)
                    if b'\x1b]11;?' in data:
                        color = b'ffff/ffff/ffff' if light else b'1111/1111/1111'
                        os.write(master, b'\x1b]11;rgb:' + color + b'\x1b\\\x1b[?0u\x1b[?62c')

            def screen(with_styles=False, with_cursor=False):
                # Yuke paints absolute cursor moves. Replay them instead of searching its diff bytes.
                # This fixture contains only ASCII and one-cell box-drawing/braille characters.
                cells = [[' '] * width for _ in range(height)]
                styles = [[(None, None)] * width for _ in range(height)]
                foreground = background = None
                row = column = offset = 0
                text = transcript.decode(errors='replace')
                while offset < len(text):
                    if text[offset] == '\x1b':
                        control = re.match(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))", text[offset:])
                        if control is None:
                            break  # A control sequence can span two PTY reads.
                        sequence = control.group()
                        if sequence.startswith('\x1b['):
                            if sequence.endswith('H'):
                                row, column = (int(part) - 1 for part in sequence[2:-1].split(';'))
                            elif sequence.endswith('m') and not sequence[2:-1].startswith('>'):
                                values = [int(part) for part in sequence[2:-1].split(';') if part]
                                index = 0
                                while index < len(values):
                                    code = values[index]
                                    if code == 0:
                                        foreground = background = None
                                    elif code == 39:
                                        foreground = None
                                    elif code == 49:
                                        background = None
                                    elif code in (38, 48):
                                        assert values[index + 1] == 2, 'This truecolor fixture expects RGB SGR.'
                                        color = tuple(values[index + 2:index + 5])
                                        if code == 38:
                                            foreground = color
                                        else:
                                            background = color
                                        index += 4
                                    index += 1
                            else:
                                assert sequence[-1] in 'mhlucq' , f'Unsupported terminal control: {sequence!r}'
                        offset += len(sequence)
                        continue
                    character = text[offset]
                    if character == '\r':
                        column = 0
                    elif character == '\n':
                        row += 1
                    elif character >= ' ':
                        if 0 <= row < height and 0 <= column < width:
                            cells[row][column] = character
                            styles[row][column] = (foreground, background)
                        column += 1
                    offset += 1
                lines = [''.join(line) for line in cells]
                if with_cursor:
                    return lines, styles, (row, column)
                return (lines, styles) if with_styles else lines

            def wait_for(check):
                end = time.monotonic() + 8
                while not check():
                    assert time.monotonic() < end, transcript.decode(errors='replace')[-7000:]
                    pump()

            pump(1)
            if resume:
                # This nightly opens startup sessions before local plugin hooks load.
                os.write(master, b'/reload\r')
                pump(1)
            os.write(master, b'main task\r')
            wait_for(lambda: len(requests) == 2)
            pump(0.3)
            if not main_running:
                release.set()
                pump(0.5)
            if inline:
                os.write(master, b'/btw explain this\r')
            else:
                os.write(master, b'/btw\r')
                pump(0.3)
                os.write(master, b'explain this\r')
            wait_for(lambda: len(requests) == 3)
            frames = set()
            for _ in range(4):
                pump(0.12)
                activity = next((line for line in screen() if 'Working…' in line), '')
                frames.update(set(activity).intersection("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"))
            assert len(frames) > 1, 'The side-panel indicator did not animate.'
            waiting_rows = screen()
            activity_row = next(i for i, line in enumerate(waiting_rows) if 'Working…' in line)
            composer_row = next(i for i, line in enumerate(waiting_rows) if 'Ask a side question' in line)
            assert composer_row - activity_row == 2, 'Activity must be directly above the composer.'
            if cancel_side:
                os.write(master, b'\x1b')
                wait_for(side_closed.is_set)
                assert not release.is_set(), 'Closing the side panel must not stop the main stream.'
                assert len(requests) == 3
                assert not list((root / 'data/yuke/plugins/btw/history').glob('*/*.json'))
                release.set()
                pump(0.3)
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
                pid = None
                os.close(master)
                print(f'PASS real TUI {width}x{height}: Escape closes the actual side HTTP stream, keeps the main stream running, and saves no incomplete answer')
                return
            release_side.set()
            wait_for(lambda: any('SIDE ANSWER OK' in line for line in screen()))
            top = height - min(height, max(9, (height * 3 + 4) // 5))
            panel = screen()[top:]
            assert any('/btw explain this' in line for line in panel), panel
            assert not any(line.strip() in ['You', 'Yuke', 'btw'] for line in panel), panel
            assert not any(re.search(r'cached round|main task|asking in parallel', line, re.I) for line in panel), panel
            assert sum('/btw' in line for line in panel) == 1, 'Use one command/question heading.'
            lines, styles, cursor = screen(with_cursor=True)
            title_row = next(i for i, line in enumerate(lines) if '/btw explain this' in line)
            title_column = lines[title_row].index('/btw')
            accent = (45, 106, 79) if light else (168, 207, 160)
            assert styles[title_row][title_column] == (accent, None), styles[title_row][title_column]
            answer_row = next(i for i, line in enumerate(lines) if 'SIDE ANSWER OK' in line)
            answer_column = lines[answer_row].index('SIDE ANSWER OK')
            assert answer_column == title_column + 2, 'Indent the answer, not the whole exchange.'
            assert styles[answer_row][answer_column] == (None, None)
            assert lines[title_row + 1].strip() == '', 'Leave a blank row after the question.'
            assert re.fullmatch('─+', lines[top].strip()), 'Separate the panel from the main chat with a plain rule.'
            assert all(color[1] is None for row in styles[top:] for color in row), 'No filled panel or input box.'
            input_row = next(i for i, line in enumerate(lines) if 'Ask a side question' in line)
            input_column = lines[input_row].index('›')
            assert styles[input_row][input_column] == (None, None), styles[input_row][input_column]
            assert styles[input_row][input_column - 1] == (None, None), 'The field needs inner left padding.'
            assert styles[input_row][input_column - 2][1] is None
            right = width - (2 if width >= 80 else 0) - 2
            assert styles[input_row][right] == (None, None), 'The field needs inner right padding.'
            assert styles[input_row][right + 1][1] is None
            assert input_row == height - 2, 'The empty composer must occupy only one row.'
            assert cursor == (input_row, lines[input_row].index('Ask a side question') - 1), cursor
            assert lines[cursor[0]][cursor[1]] == ' ', 'The cursor must not cover the placeholder.'
            assert re.fullmatch('─+', lines[input_row - 1].strip()), 'Use a rule above the flat composer.'
            footer = lines[-1]
            assert 'History ·' not in footer, footer
            assert 'Enter send' in footer and 'Esc close' in footer, footer
            assert not re.search(r'copy|Tab focus|scroll', footer), footer
            if width >= 80:
                assert 'Ctrl+R history' in footer, footer
            if width >= 80:
                assert styles[title_row][0][1] is None, 'Desktop panel keeps outer terminal margins.'
            composer = next(line for line in panel if 'Ask a side question' in line)
            assert composer.strip().startswith('›'), composer
            if main_running:
                assert not release.is_set(), 'The main stream must still be blocked.'
            files = list((root / 'data/yuke/plugins/btw/history').glob('*/*.json'))
            assert len(files) == 1, files
            saved = json.loads(files[0].read_text())
            assert saved['question'] == 'explain this'
            assert saved['answer'] == 'SIDE ANSWER OK'
            assert saved['model'] == {'provider': 'local', 'model': 'small'}
            assert set(saved) == {'version', 'id', 'sessionId', 'createdAt', 'model', 'question', 'answer'}
            assert stat.S_IMODE(files[0].stat().st_mode) == 0o600
            assert stat.S_IMODE(files[0].parent.stat().st_mode) == 0o700
            assert stat.S_IMODE(files[0].parent.parent.stat().st_mode) == 0o700
            def field_height():
                rules = [i for i, line in enumerate(screen()) if re.fullmatch('─+', line.strip())]
                assert rules, 'The composer separator must remain visible.'
                return height - rules[-1] - 2

            def paste(draft):
                os.write(master, b'\x1b[200~' + draft.encode() + b'\x1b[201~')
                pump(0.15)

            paste('x' * 27)
            assert field_height() == (2 if width == 32 else 1), 'Wrapping must use the padded editor width.'
            os.write(master, b'\x15')  # Ctrl+U clears this logical line.
            wait_for(lambda: any('Ask a side question' in line for line in screen()))
            assert field_height() == 1, 'Clearing must shrink the composer.'
            draft = 'first\nsecond'
            paste(draft)
            assert field_height() == 2, 'Explicit newlines must grow the composer.'
            more = '\nthird\nfourth'
            paste(more)
            assert field_height() == 3, 'A longer draft must stay bounded to three visible rows.'
            assert any('fourth' in line for line in screen()), 'The caret line must remain visible.'
            os.write(master, b'\x7f' * len(draft + more))
            wait_for(lambda: any('Ask a side question' in line for line in screen()))
            assert field_height() == 1
            assert len(requests) == 3, 'Editing the next draft must not issue a request.'
            os.write(master, b'\x12')  # Ctrl+R opens saved answers, not a model request.
            wait_for(lambda: any('btw history' in line for line in screen()))
            os.write(master, b'ANSWER OK')
            pump(0.15)
            os.write(master, b'\r')
            wait_for(lambda: any('/btw explain this' in line for line in screen()) and not any('btw history' in line for line in screen()))
            assert len(requests) == 3
            main, side = requests[1:]
            expected = copy.deepcopy(main)
            question = side['messages'][-1]['content'][-1]
            assert question['text'].endswith('explain this'), question
            assert 'cache_control' not in question
            assert side['messages'][-1]['content'][-2]['cache_control'] == {'type': 'ephemeral'}
            expected['messages'][-1]['content'].append(question)
            assert side == expected, 'The side request changed the cached main request prefix.'
            os.write(master, b'\x1b')
            pump(0.2)
            release.set()
            pump(0.5)
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
            pid = None
            os.close(master)
            pid, master = pty.fork()
            if pid == 0:
                os.chdir(root / 'work')
                # Also verify all-session history from a fresh, unbound pane.
                os.execve(YUKE, [YUKE] + ([] if not main_running else ['-c']), env)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
            pump(1)
            os.write(master, b'/btw\r' if main_running else b'/btw:history\r')
            if not main_running:
                wait_for(lambda: any('btw history' in line for line in screen()))
                pump(0.15)
                os.write(master, b'\r')
            wait_for(lambda: any('/btw explain this' in line for line in screen()) and not any('btw history' in line for line in screen()))
            assert any('SIDE ANSWER OK' in line for line in screen())
            assert len(requests) == 3, 'Browsing after restart must not contact the provider.'
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
            pid = None
            os.close(master)
            print(f'PASS real TUI {"resumed + reload" if resume else "new"} {width}x{height} {"light" if light else "dark"} {"inline /btw question" if inline else "/btw prompt"}: {"parallel" if main_running else "idle-main"} answer, flat native colors, distinct question/answer, growing flat composer, loading above composer, private history after restart, identical cached prefix')
    finally:
        Path("/tmp/yuke-btw-pty.log").write_bytes(transcript)
        release.set()
        release_side.set()
        if pid is not None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    for resume in [False, True]:
        for width, height in [(32, 24), (100, 35)]:
            for light in [False, True]:
                scenario(width, height, light, inline=light, resume=resume)

    scenario(100, 35, False, inline=True, resume=False, main_running=False)

    scenario(100, 35, False, inline=False, resume=False, cancel_side=True)
