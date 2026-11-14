"""The plugin through the real `yuke --rpc`, with a fake model on a local port. It costs no tokens.

Run it with `python3 plugins/subagents/tests/rpc.py`. The variable YUKE names another binary.
"""

import collections
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time

PLUGIN = Path(__file__).resolve().parent.parent
YUKE = os.environ.get('YUKE') or shutil.which('yuke')
WAIT = 15
SPAWN = {'description': 'Read the store', 'message': 'Read the store.', 'background': True}
# A child tool that asks the user, as a tool of another plugin does.
ASKER = """export function session(s) {
  s.tools.add({
    name: 'ask_user', description: 'Ask.', concurrency: 'serial',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args, { signal }) {
      const question = { id: 'go', header: 'Go', question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] };
      return JSON.stringify(await s.ask({ questions: [question] }, { signal }));
    },
  });
}
"""


def text(value):
    return {'text': value}


def call(name, args):
    return {'tool': name, 'args': args}


class Model:
    """A fake Anthropic endpoint: the replies of the parent and of the subagents, in order."""

    def __init__(self):
        self.parent = collections.deque()
        self.child = collections.deque()
        self.requests = []
        self.errors = []
        self.release = threading.Event()
        model = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                model.requests.append(body)
                is_child = 'You are a subagent working' in json.dumps(body.get('system'))
                replies = model.child if is_child else model.parent
                if not replies:
                    model.errors.append(f'no reply for the {"child" if is_child else "parent"}: {body["messages"][-1]}')
                    self.send_error(500)
                    return
                reply = replies.popleft()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                try:
                    self.stream(reply)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def stream(self, reply):
                if 'stall' in reply:
                    model.release.wait(WAIT)
                    return
                args = reply['args']() if callable(reply.get('args')) else reply.get('args')
                block = (
                    {'type': 'tool_use', 'id': f'call-{len(model.requests)}', 'name': reply['tool'], 'input': {}}
                    if 'tool' in reply
                    else {'type': 'text', 'text': ''}
                )
                delta = (
                    {'type': 'input_json_delta', 'partial_json': json.dumps(args)}
                    if 'tool' in reply
                    else {'type': 'text_delta', 'text': reply['text']}
                )
                stop = 'tool_use' if 'tool' in reply else 'end_turn'
                for event in [
                    {'type': 'message_start', 'message': {'usage': {'input_tokens': 1}}},
                    {'type': 'content_block_start', 'index': 0, 'content_block': block},
                    {'type': 'content_block_delta', 'index': 0, 'delta': delta},
                    {'type': 'content_block_stop', 'index': 0},
                    {'type': 'message_delta', 'delta': {'stop_reason': stop}, 'usage': {'output_tokens': 1}},
                    {'type': 'message_stop'},
                ]:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


class Client:
    """A JSON-RPC client of `yuke --rpc`. It keeps each notification for `until`."""

    def __init__(self, env, cwd):
        self.process = subprocess.Popen(
            [YUKE, '--rpc'], env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        self.lines = queue.Queue()
        self.seen = []
        self.replies = {}
        self.next_id = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            self.lines.put(json.loads(line))

    def pump(self, deadline):
        message = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
        if 'id' in message and 'method' not in message:
            self.replies[message['id']] = message
        else:
            self.seen.append(message)

    def call(self, method, params):
        self.next_id += 1
        request = self.next_id
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': request, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + WAIT
        while request not in self.replies:
            self.pump(deadline)
        reply = self.replies.pop(request)
        assert 'error' not in reply, f'{method}: {reply["error"]}'
        return reply['result']

    def until(self, what, test):
        """The first notification that passes `test`. The earlier notifications go, so each search reads later events."""
        deadline = time.monotonic() + WAIT
        while True:
            for index, message in enumerate(self.seen):
                if test(message):
                    self.seen = self.seen[index + 1 :]
                    return message
            try:
                self.pump(deadline)
            except queue.Empty:
                raise AssertionError(f'no {what}. Seen: {json.dumps(self.seen)[-2000:]}') from None


def update_of(message):
    return message.get('params', {}).get('update', {})


def activity(session, state):
    return lambda message: message.get('params', {}).get('sessionId') == session and update_of(message).get('state') == state


def idle(session):
    return activity(session, 'idle')


def job(session, state):
    return (
        lambda message: message.get('params', {}).get('sessionId') == session
        and update_of(message).get('sessionUpdate') == 'job'
        and update_of(message)['job']['state'] == state
    )


def report(session):
    def test(message):
        update = update_of(message)
        return (
            message.get('params', {}).get('sessionId') == session
            and update.get('sessionUpdate') == 'inputAccepted'
            and update['input']['kind'] == 'notification'
        )

    return test


def new_parent(client, cwd):
    settings = {'reasoning': {}, 'toolChoice': 'auto'}
    settings = {'model': {'provider': 'local', 'model': 'small'}, 'settings': settings, 'cwd': str(cwd)}
    return client.call('session/new', settings)['sessionId']


def children(client, parent):
    return [row['session']['sessionId'] for row in client.call('session/list', {'parent': parent})['sessions']]


def send(client, session, value):
    return client.call('session/input', {'sessionId': session, 'content': [{'kind': 'userText', 'text': value}]})


def background_flow(client, model, cwd):
    """A background subagent: its job, its report, the load of its session by the job id, and a follow-up."""
    parent = new_parent(client, cwd)
    state = {}
    model.parent.extend(
        [
            call('spawn_subagent', SPAWN),
            text('Started.'),
            text('Noted.'),
            call('message_subagent', lambda: {'id': state['id'], 'message': 'And the indexes?', 'background': True}),
            text('Asked.'),
            text('Thanks.'),
        ]
    )
    model.child.extend([text('Two tables.'), text('Three indexes.')])

    send(client, parent, 'Read the store.')
    started = client.until('a running job', job(parent, 'running'))
    item = update_of(started)['job']
    state['id'] = item['id']
    assert (item['label'], item['kind'], item['plugin']) == ('Read the store', 'plugin', 'subagents'), item

    ended = report(parent)
    first = client.until('the first report', ended)
    client.until('the parent idle', idle(parent))
    shown = update_of(first)['input']['content'][0]['text']
    read = update_of(first)['input']['modelContent'][0]['text']
    assert shown == 'Read the store · completed', shown
    assert read == (
        f'<system_notification plugin="subagents">{item["id"]} Read the store: completed.\nTwo tables.</system_notification>'
    ), read

    # The job id alone is enough for a client: it names the session of the subagent.
    assert children(client, parent) == [item['id']]
    client.call('session/load', {'sessionId': item['id']})
    client.until(
        'the transcript of the subagent',
        lambda message: message.get('params', {}).get('sessionId') == item['id'] and 'Two tables.' in json.dumps(message),
    )
    assert client.call('session/get', {'sessionId': item['id']})['session']['parent'] == parent

    send(client, parent, 'And the indexes?')
    second = client.until('the second report', ended)
    client.until('the parent idle', idle(parent))
    assert 'Three indexes.' in update_of(second)['input']['modelContent'][0]['text'], second
    assert children(client, parent) == [item['id']]
    # The default of settings.json gives the subagent the model `big`, and the parent keeps `small`.
    used = {('child' if 'You are a subagent working' in json.dumps(body.get('system')) else 'parent', body['model']) for body in model.requests}
    assert used == {('child', 'big'), ('parent', 'small')}, used
    client.call('session/close', {'sessionId': item['id']})
    client.call('session/close', {'sessionId': parent})


def foreground_flow(client, model, cwd):
    """A foreground subagent: the tool result holds its id and its report, and no notification follows."""
    parent = new_parent(client, cwd)
    model.parent.extend([call('spawn_subagent', {**SPAWN, 'background': False}), text('Done.')])
    model.child.append(text('Two tables.'))

    send(client, parent, 'Read the store.')
    client.until('the parent runs', activity(parent, 'running'))
    client.until('the parent idle', idle(parent))
    last = json.dumps(model.requests[-1]['messages'][-1])
    child = children(client, parent)
    assert f'Subagent {child[0]}:' in last and 'Two tables.' in last, last
    assert not any(report(parent)(message) for message in client.seen), client.seen
    client.call('session/close', {'sessionId': parent})


def question_flow(client, model, cwd):
    """A question of a subagent reaches the client on the parent session, and the answer returns to the subagent."""
    parent = new_parent(client, cwd)
    model.parent.extend([call('spawn_subagent', SPAWN), text('Started.'), text('Noted.')])
    model.child.extend([call('ask_user', {}), text('It said yes.')])

    send(client, parent, 'Ask first.')
    # The client also sees the question on the session of the subagent, with the source `asker`.
    asked = client.until(
        'a question on the parent',
        lambda message: message.get('params', {}).get('sessionId') == parent
        and update_of(message).get('sessionUpdate') == 'interactionRequested',
    )
    update = update_of(asked)
    assert update['source'] == 'subagents', update
    client.call(
        'interaction/respond',
        {
            'sessionId': parent,
            'interactionId': update['interactionId'],
            'response': {'kind': 'questions', 'answers': [{'id': 'go', 'values': ['Yes']}]},
        },
    )
    done = client.until('the report', report(parent))
    client.until('the parent idle', idle(parent))
    assert 'It said yes.' in update_of(done)['input']['modelContent'][0]['text'], done
    client.call('session/close', {'sessionId': parent})


def stop_flow(client, model, cwd):
    """`job/stop` with the job id stops a subagent, and no report follows."""
    parent = new_parent(client, cwd)
    model.parent.extend([call('spawn_subagent', SPAWN), text('Started.')])
    model.child.append({'stall': True})

    send(client, parent, 'Read the store.')
    item = update_of(client.until('a running job', job(parent, 'running')))['job']
    client.until('the parent idle', idle(parent))
    assert client.call('job/list', {'sessionId': parent})['jobs'][0]['id'] == item['id']
    client.call('job/stop', {'sessionId': parent, 'jobId': item['id']})
    stopped = client.until('a stopped job', job(parent, 'stopped'))
    model.release.set()
    assert update_of(stopped)['job']['id'] == item['id'], stopped
    assert client.call('job/list', {'sessionId': parent})['jobs'] == []
    assert not any(report(parent)(message) for message in client.seen), client.seen
    client.call('session/close', {'sessionId': parent})


def restart_flow(env, work, model):
    """A kill of yuke during a run: the next process tells the user at the load, and the model with the next input."""
    first = Client(env, work)
    first.call('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'rpc.py', 'version': '0'}})
    parent = new_parent(first, work)
    model.release.clear()
    model.parent.extend([call('spawn_subagent', SPAWN), text('Started.')])
    model.child.append({'stall': True})
    send(first, parent, 'Read the store.')
    item = update_of(first.until('a running job', job(parent, 'running')))['job']
    first.until('the parent idle', idle(parent))
    deadline = time.monotonic() + WAIT
    logged = Path(env['XDG_DATA_HOME']) / f'yuke/plugins/subagents/running/{parent}.json'
    while not logged.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    first.process.kill()
    first.process.wait(WAIT)
    model.release.set()

    second = Client(env, work)
    try:
        second.call('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'rpc.py', 'version': '0'}})
        second.call('session/load', {'sessionId': parent})
        notice = second.until(
            'the notice of the interrupted subagent',
            lambda message: message.get('method') == 'notice' and 'interrupted' in json.dumps(message),
        )
        assert notice['params']['text'] == 'Read the store · interrupted', notice
        assert model.requests[-1:] and 'stopped when yuke closed' not in json.dumps(model.requests[-1]['messages'][-1])
        before = len(model.requests)
        model.parent.extend([text('I see.'), text('Noted again.')])
        send(second, parent, 'What happened?')
        second.until('the parent runs', activity(parent, 'running'))
        second.until('the parent idle', idle(parent))
        told = json.dumps(model.requests[before]['messages'])
        assert f'Subagent {item["id"]} (Read the store) stopped when yuke closed' in told, told
        assert 'What happened?' in told, told
        # The model hears it once.
        send(second, parent, 'And now?')
        second.until('the parent runs', activity(parent, 'running'))
        second.until('the parent idle', idle(parent))
        last = json.dumps(model.requests[-1]['messages'][-1])
        assert 'stopped when yuke closed' not in last, last
        assert not logged.exists(), logged
    finally:
        second.process.stdin.close()
        try:
            second.process.wait(WAIT)
        except subprocess.TimeoutExpired:
            second.process.kill()


def main():
    model = Model()
    with tempfile.TemporaryDirectory(prefix='yuke-subagents-rpc-') as root:
        root = Path(root)
        config = root / 'config/yuke'
        (config / 'asker').mkdir(parents=True)
        work = root / 'work'
        work.mkdir()
        (config / 'asker/plugin.json').write_text(
            json.dumps({'name': 'asker', 'version': '0.1.0', 'extensions': {'sh.yuke': {'entry': 'index.js'}}})
        )
        (config / 'asker/index.js').write_text(ASKER)
        (config / 'config.json').write_text(json.dumps({'plugins': [str(PLUGIN), './asker']}))
        (config / 'providers.json').write_text(
            json.dumps(
                {
                    'providers': [
                        {
                            'id': 'local',
                            'base_url': f'http://127.0.0.1:{model.server.server_port}/v1',
                            'endpoints': [{'protocol': 'anthropic_messages', 'cache_breakpoint': True}],
                            'models': [
                                {
                                    'id': 'small',
                                    'flags': {'supports_cache_breakpoint': True},
                                    'limits': {'context_window': 64000, 'max_output_tokens': 4096},
                                },
                                {
                                    'id': 'big',
                                    'flags': {'supports_cache_breakpoint': True},
                                    'limits': {'context_window': 64000, 'max_output_tokens': 4096},
                                },
                            ],
                        }
                    ]
                }
            )
        )
        # A client of `yuke --rpc` has no dialog, so it edits this file.
        data = root / 'data/yuke/plugins/subagents'
        data.mkdir(parents=True)
        (data / 'settings.json').write_text(
            json.dumps({'default': 'local/big:default', 'models': [{'model': 'local/big', 'reasoning': 'default'}]})
        )
        env = dict(
            os.environ,
            HOME=str(root),
            XDG_CONFIG_HOME=str(root / 'config'),
            XDG_DATA_HOME=str(root / 'data'),
            XDG_CACHE_HOME=str(root / 'cache'),
            XDG_STATE_HOME=str(root / 'state'),
        )
        client = Client(env, work)
        try:
            client.call('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'rpc.py', 'version': '0'}})
            loaded = {plugin['name']: plugin['loaded'] for plugin in client.call('plugin/list', {})['plugins']}
            assert loaded == {'subagents': True, 'asker': True}, loaded
            for flow in [background_flow, foreground_flow, question_flow, stop_flow]:
                flow(client, model, work)
                assert not model.errors, model.errors
                print(f'ok {flow.__name__}')
            restart_flow(env, work, model)
            assert not model.errors, model.errors
            print('ok restart_flow')
        finally:
            client.process.stdin.close()
            try:
                client.process.wait(WAIT)
            except subprocess.TimeoutExpired:
                client.process.kill()
            errors = client.process.stderr.read()
            if client.process.returncode != 0:
                print(errors[-2000:])


if __name__ == '__main__':
    main()
