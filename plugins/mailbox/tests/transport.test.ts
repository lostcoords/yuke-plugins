import { connect } from "yuke:net";
import { assert, equal, listenOnTemporarySocket, rejects, waitForSettled, test } from "yuke:test";
import { readFrame, request, serve, writeFrame } from "../src/transport.ts";

/** A short socket path that no listener holds. */
function freePath(): string {
  using listener = listenOnTemporarySocket();
  return listener.path;
}

test("a JSON frame survives split UTF-8 bytes, embedded newlines, and a large message", async () => {
  const controller = new AbortController();
  using listener = listenOnTemporarySocket();
  const accepted = listener.accept();
  using client = await connect({ path: listener.path, signal: controller.signal });
  using peer = await accepted;
  const received = readFrame(peer);
  const message = { text: `Line one\n猫${"x".repeat(100_000)}` };
  const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
  const character = bytes.indexOf(0xe7);
  await client.write(bytes.slice(0, character + 1));
  await client.write(bytes.slice(character + 1, character + 2));
  await client.write(bytes.slice(character + 2));
  equal(await received, message);
});

test("the request returns a server result and reports a handler failure without stopping later requests", async () => {
  const controller = new AbortController();
  const path = freePath();
  const errors: unknown[] = [];
  const close = serve(
    path,
    controller.signal,
    async (value) => {
      if (value === "fail") throw new Error("the session is closed");
      return { answer: value };
    },
    (error) => errors.push(error),
  );
  try {
    const failed = await rejects(request(path, "fail", controller.signal));
    assert(failed instanceof Error);
    equal(failed.message, "the session is closed");
    equal(await request(path, "ready", controller.signal), { answer: "ready" });
    equal(errors, []);
  } finally {
    await close();
  }
});

test("a truncated frame fails instead of delivering a partial message", async () => {
  using listener = listenOnTemporarySocket();
  const accepted = listener.accept();
  const client = await connect({ path: listener.path });
  using peer = await accepted;
  const received = readFrame(peer);
  await client.write(new TextEncoder().encode('{"message":"partial"}'));
  client.close();
  const error = await rejects(received);
  assert(error instanceof Error);
  equal(error.message, "the peer closed before the message ended");
});

test("stopping the server closes accepted clients that have not sent a frame", async () => {
  const controller = new AbortController();
  const path = freePath();
  const close = serve(
    path,
    controller.signal,
    async () => "unused",
    (error) => {
      throw error;
    },
  );
  using client = await connect({ path });
  await waitForSettled();
  controller.abort();
  await close();
  const reader = client.readable.getReader();
  equal(await reader.read(), { value: undefined, done: true });
  reader.releaseLock();
});

test("a request waits for a complete response frame and rejects a response without a result", async () => {
  const controller = new AbortController();
  using listener = listenOnTemporarySocket();
  const accepted = listener.accept();
  const pending = request(listener.path, { method: "list" }, controller.signal);
  using peer = await accepted;
  equal(await readFrame(peer), { method: "list" });
  await writeFrame(peer, { other: "missing" });
  const error = await rejects(pending);
  assert(error instanceof Error);
  equal(error.message, "the peer returned no result");
});

test("cancelling a request stops a wait for a response with the abort reason", async () => {
  const controller = new AbortController();
  using listener = listenOnTemporarySocket();
  const accepted = listener.accept();
  const pending = request(listener.path, { method: "list" }, controller.signal);
  using peer = await accepted;
  equal(await readFrame(peer), { method: "list" });
  const reason = new Error("the user cancelled");
  controller.abort(reason);
  equal(await rejects(pending), reason);
});
