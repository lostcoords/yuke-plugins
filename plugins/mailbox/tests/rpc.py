"""Test mailbox through two real ``yuke --rpc`` processes.

The fake Anthropic endpoint runs on localhost. The test makes no paid model
calls. Run it with ``YUKE=/path/to/yuke python3 plugins/mailbox/tests/rpc.py``.
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
YUKE = os.environ.get("YUKE") or shutil.which("yuke")
WAIT = 15


def tool(name, args=None):
    def arguments(body):
        return {"name": name, "arguments": args(body) if callable(args) else (args or {})}

    return {"tool": "tool_call", "args": arguments}


def search():
    return {"tool": "tool_search", "args": {"query": "mailbox", "limit": 2}}


def text(value):
    return {"text": value}


class Model:
    """Serve scripted Anthropic responses for the two process-local models."""

    def __init__(self):
        self.left_id = None
        self.right_id = None
        self.replies = {
            "left": collections.deque(
                [
                    search(),
                    tool("mailbox_list_agents"),
                    text("I found the agents."),
                    tool("mailbox_send_message", lambda _body: {"to": self.right_id, "message": "hello from left"}),
                    text("The message is queued."),
                ]
            ),
            "right": collections.deque(
                [search(), tool("mailbox_list_agents"), text("I found the agents.")],
            ),
        }
        self.requests = []
        self.errors = []
        self.condition = threading.Condition()
        model = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    with model.condition:
                        model.requests.append(body)
                        model.condition.notify_all()
                    name = body.get("model", "").split("/")[-1]
                    reply = model.reply_for(name, body)
                    if reply is None:
                        raise AssertionError(f"no scripted reply for {name}: {body['messages'][-1]}")
                    args = reply.get("args", {})
                    if callable(args):
                        args = args(body)
                    block = (
                        {
                            "type": "tool_use",
                            "id": f"call-{len(model.requests)}",
                            "name": reply["tool"],
                            "input": {},
                        }
                        if "tool" in reply
                        else {"type": "text", "text": ""}
                    )
                    delta = (
                        {"type": "input_json_delta", "partial_json": json.dumps(args)}
                        if "tool" in reply
                        else {"type": "text_delta", "text": reply["text"]}
                    )
                    stop = "tool_use" if "tool" in reply else "end_turn"
                    events = [
                        {"type": "message_start", "message": {"usage": {"input_tokens": 1}}},
                        {"type": "content_block_start", "index": 0, "content_block": block},
                        {"type": "content_block_delta", "index": 0, "delta": delta},
                        {"type": "content_block_stop", "index": 0},
                        {
                            "type": "message_delta",
                            "delta": {"stop_reason": stop},
                            "usage": {"output_tokens": 1},
                        },
                        {"type": "message_stop"},
                    ]
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for event in events:
                        self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception as error:  # The parent reports this as a test failure.
                    with model.condition:
                        model.errors.append(str(error))
                        model.condition.notify_all()
                    self.send_error(500)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reply_for(self, name, body):
        """Use a notification response even if the two processes race."""
        serialized = json.dumps(body.get("messages", [])[-1:])
        if name == "right" and "hello from left" in serialized:
            self.replies["right"].append(text("The reply is queued."))
            return tool("mailbox_send_message", {"to": self.left_id, "message": "reply from right"})
        if name == "left" and "reply from right" in serialized:
            return text("The reply arrived.")
        with self.condition:
            if not self.replies.get(name):
                return None
            return self.replies[name].popleft()

    def wait_for(self, name, predicate, start=0):
        deadline = time.monotonic() + WAIT
        with self.condition:
            while True:
                for body in self.requests[start:]:
                    if body.get("model", "").split("/")[-1] == name and predicate(body):
                        return body
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    recent = json.dumps(self.requests[-3:])[-3000:]
                    raise AssertionError(f"no {name} model request. Recent requests: {recent}")
                self.condition.wait(remaining)


def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def tool_result_values(body):
    """Return values from actual tool-result blocks in one model request."""
    values = []
    for value in walk(body.get("messages", [])[-1:]):
        if isinstance(value, dict) and value.get("type") == "tool_result":
            values.extend(walk(value.get("content", [])))
    return values


def agent_result(body):
    """Read the JSON text returned by ``mailbox_list_agents`` from a follow-up request."""
    for value in tool_result_values(body):
        if not isinstance(value, str):
            continue
        try:
            result = json.loads(value)
        except json.JSONDecodeError:
            continue
        if isinstance(result, dict) and isinstance(result.get("agents"), list) and isinstance(
            result.get("self"), str
        ):
            return result
    raise AssertionError(f"the model request has no mailbox_list_agents result: {json.dumps(body)}")


def has_agent_result(body):
    try:
        agent_result(body)
    except AssertionError:
        return False
    return True


def queued_result(body, peer_id):
    for value in tool_result_values(body):
        if not isinstance(value, str):
            continue
        try:
            result = json.loads(value)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(result, dict)
            and result.get("status") == "queued"
            and result.get("to") == peer_id
        ):
            return result
    return None


class Client:
    """A small JSON-RPC client that keeps notifications for later checks."""

    def __init__(self, env, cwd):
        if not YUKE:
            raise AssertionError("YUKE is not set and yuke is not on PATH")
        self.process = subprocess.Popen(
            [YUKE, "--rpc"],
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.lines = queue.Queue()
        self.seen = []
        self.replies = {}
        self.next_id = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            try:
                self.lines.put(json.loads(line))
            except json.JSONDecodeError as error:
                self.lines.put({"read_error": str(error), "line": line})

    def pump(self, deadline):
        message = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
        if "id" in message and "method" not in message:
            self.replies[message["id"]] = message
        else:
            self.seen.append(message)

    def call(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        try:
            self.process.stdin.write(json.dumps(request) + "\n")
            self.process.stdin.flush()
        except BrokenPipeError:
            raise AssertionError(f"yuke stopped before {method}: {self.process.stderr.read()}") from None
        deadline = time.monotonic() + WAIT
        while request_id not in self.replies:
            self.pump(deadline)
        reply = self.replies.pop(request_id)
        if "error" in reply:
            raise AssertionError(f"{method}: {reply['error']}")
        return reply["result"]

    def until(self, description, predicate):
        deadline = time.monotonic() + WAIT
        while True:
            for index, message in enumerate(self.seen):
                if predicate(message):
                    self.seen = self.seen[index + 1 :]
                    return message
            try:
                self.pump(deadline)
            except queue.Empty:
                raise AssertionError(f"no {description}: {json.dumps(self.seen)[-2000:]}") from None

    def close(self):
        if self.process.poll() is not None:
            return
        self.process.stdin.close()
        try:
            self.process.wait(WAIT)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(WAIT)
        if self.process.returncode:
            error = self.process.stderr.read()
            raise AssertionError(f"yuke exited with {self.process.returncode}: {error[-3000:]}")


def records(peers):
    """Each registry entry, with its socket path. The entry is empty: its name is the runtime id."""
    return {path: Path(f"/tmp/yuke-mailbox-{path.stem}/socket") for path in peers.glob("*.json")}


def assert_closed(before, after):
    """Exactly one endpoint closed: its entry, its socket, and its private socket folder are gone."""
    closed = [socket for path, socket in before.items() if path not in after]
    assert len(closed) == 1, (before, after)

    socket = closed[0]
    assert socket.name == "socket" and socket.parent.name.startswith("yuke-mailbox-"), socket
    assert not socket.parent.exists(), socket.parent


def new_session(client, cwd, model):
    settings = {"reasoning": {}, "toolChoice": "auto"}
    result = client.call(
        "session/new",
        {
            "model": {"provider": "local", "model": model},
            "settings": settings,
            "cwd": str(cwd),
        },
    )
    return result["sessionId"]


def send(client, session, value):
    return client.call("session/input", {"sessionId": session, "content": [{"kind": "userText", "text": value}]})


def update_of(message):
    return message.get("params", {}).get("update", {})


def idle(session):
    return lambda message: (
        message.get("params", {}).get("sessionId") == session and update_of(message).get("state") == "idle"
    )


def main():
    root = Path(tempfile.mkdtemp(prefix="yuke-mailbox-rpc-"))
    clients = []
    model = None
    try:
        config = root / "config/yuke"
        config.mkdir(parents=True)
        work = root / "work"
        work.mkdir()
        (config / "config.json").write_text(json.dumps({"plugins": [str(PLUGIN)]}))
        model = Model()
        (config / "providers.json").write_text(
            json.dumps(
                {
                    "providers": [
                        {
                            "id": "local",
                            "base_url": f"http://127.0.0.1:{model.server.server_port}/v1",
                            "endpoints": [{"protocol": "anthropic_messages", "cache_breakpoint": True}],
                            "models": [
                                {
                                    "id": name,
                                    "flags": {"supports_cache_breakpoint": True},
                                    "limits": {"context_window": 64000, "max_output_tokens": 4096},
                                }
                                for name in ("left", "right")
                            ],
                        }
                    ]
                }
            )
        )
        env = dict(
            os.environ,
            HOME=str(root),
            XDG_CONFIG_HOME=str(root / "config"),
            XDG_DATA_HOME=str(root / "data"),
            XDG_CACHE_HOME=str(root / "cache"),
            XDG_STATE_HOME=str(root / "state"),
        )

        for _ in range(2):
            client = Client(env, work)
            clients.append(client)
            client.call("initialize", {"protocolVersion": 1, "clientInfo": {"name": "rpc.py", "version": "0"}})
            plugins = {item["name"]: item["loaded"] for item in client.call("plugin/list", {})["plugins"]}
            assert plugins.get("mailbox") is True, plugins
        left, right = clients

        left_session = new_session(left, work, "left")
        right_session = new_session(right, work, "right")
        send(left, left_session, "Find my peers.")
        send(right, right_session, "Find my peers.")
        left.until("left idle after discovery", idle(left_session))
        right.until("right idle after discovery", idle(right_session))

        left_discovery_request = model.wait_for("left", has_agent_result)
        right_discovery_request = model.wait_for("right", has_agent_result)
        left_agents = agent_result(left_discovery_request)
        right_agents = agent_result(right_discovery_request)
        left_id = left_agents["self"]
        right_id = right_agents["self"]
        assert left_id != right_id, (left_id, right_id)
        assert any(agent["id"] == right_id for agent in left_agents["agents"]), left_agents
        assert any(agent["id"] == left_id for agent in right_agents["agents"]), right_agents
        assert all(agent["id"] != left_id for agent in left_agents["agents"]), left_agents
        model.left_id = left_id
        model.right_id = right_id
        peer_records = list((root / "data/yuke/plugins/mailbox/peers").glob("*.json"))
        assert len(peer_records) == 2, peer_records
        socket_paths = list(records(root / "data/yuke/plugins/mailbox/peers").values())
        assert all(path.exists() for path in socket_paths), socket_paths

        # The left agent sends an explicit message to the right idle agent.
        before_message = len(model.requests)
        send(left, left_session, "Send hello to the right agent.")
        left_queued_request = model.wait_for(
            "left", lambda body: queued_result(body, right_id) is not None, start=before_message
        )
        left_queued = queued_result(left_queued_request, right_id)
        assert left_queued["status"] == "queued"
        assert left_queued["to"] == right_id
        right_notification = model.wait_for(
            "right", lambda body: "hello from left" in json.dumps(body), start=before_message
        )
        notification_text = json.dumps(right_notification)
        assert left_id in notification_text, notification_text
        assert "hello from left" in notification_text, notification_text
        assert "Message from another Yuke session, not the user." in notification_text, notification_text
        right_queued_request = model.wait_for(
            "right", lambda body: queued_result(body, left_id) is not None, start=before_message
        )
        right_queued = queued_result(right_queued_request, left_id)
        assert right_queued["status"] == "queued"
        assert right_queued["to"] == left_id

        # The right agent replies through the same tool. The left agent must wake.
        left_reply = model.wait_for("left", lambda body: "reply from right" in json.dumps(body))
        assert right_id in json.dumps(left_reply), left_reply
        assert "reply from right" in json.dumps(left_reply), left_reply
        left.until("the reply answer", lambda message: "The reply arrived." in json.dumps(update_of(message)))
        left.until("left idle after reply", idle(left_session))
        right.until("the reply completion", lambda message: "The reply is queued." in json.dumps(update_of(message)))
        right.until("right idle after reply", idle(right_session))

        # Reload replaces one runtime without replacing its session or the other process.
        peers = root / "data/yuke/plugins/mailbox/peers"
        before_reload = records(peers)
        left.call("profile/reload", {})
        assert_closed(before_reload, records(peers))
        model.replies["right"].extend([tool("mailbox_list_agents"), text("I found the reloaded agent.")])
        before_reload_discovery = len(model.requests)
        send(right, right_session, "Find the reloaded agent.")
        refreshed = agent_result(model.wait_for("right", has_agent_result, start=before_reload_discovery))
        # The id of a session stays the same across a reload.
        assert [agent["id"] for agent in refreshed["agents"]] == [left_id], refreshed
        assert refreshed["self"] == right_id, refreshed
        right.until("right idle after reload discovery", idle(right_session))
        assert len(list(peers.glob("*.json"))) == 2

        model.replies["left"].clear()
        model.replies["left"].append(text("I received the post-reload message."))
        model.replies["right"].extend([
            tool("mailbox_send_message", {"to": left_id, "message": "after reload"}),
            text("The post-reload message is queued."),
        ])
        before_reload_message = len(model.requests)
        send(right, right_session, "Send to the reloaded agent.")
        model.wait_for("right", lambda body: queued_result(body, left_id) is not None, start=before_reload_message)
        after_reload = model.wait_for("left", lambda body: "after reload" in json.dumps(body), start=before_reload_message)
        assert right_id in json.dumps(after_reload), after_reload
        left.until("the post-reload answer", lambda message: "I received the post-reload message." in json.dumps(update_of(message)))
        left.until("left idle after reload", idle(left_session))
        right.until("right idle after the post-reload send", idle(right_session))

        # Stop one process cleanly. The remaining process must no longer discover it.
        before_close = records(peers)
        left.close()
        assert_closed(before_close, records(peers))

        model.replies["right"].append(tool("mailbox_list_agents"))
        model.replies["right"].append(text("The left agent is gone."))
        before_gone = len(model.requests)
        send(right, right_session, "Check which agents remain.")
        gone_request = model.wait_for("right", has_agent_result, start=before_gone)
        remaining = agent_result(gone_request)
        assert remaining["self"] == right_id, remaining
        assert all(agent["id"] != left_id for agent in remaining["agents"]), remaining
        right.until("right idle after final discovery", idle(right_session))
        right.close()
        assert not list(peers.glob("*.json")), list(peers.glob("*.json"))
        for body in model.requests:
            system = body.get("system", [])
            if isinstance(system, list):
                system = "\n".join(block.get("text", "") for block in system)
            assert system.count("<mailbox>") == 1, system
            assert system.count("</mailbox>") == 1, system
        assert not model.errors, model.errors
        print("ok mailbox rpc")
    finally:
        for client in reversed(clients):
            try:
                client.close()
            except (AssertionError, BrokenPipeError):
                client.process.kill()
        if model is not None:
            model.server.shutdown()
            model.server.server_close()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
