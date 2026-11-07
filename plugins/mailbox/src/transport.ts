import { ConnectionError, connect, listen, type UnixConnection } from "yuke:net";

/** The longest frame, in UTF-16 units. A peer that sends more is broken or hostile. */
const MAX_FRAME = 4 * 1024 * 1024;

/** The pause after a failed accept, such as one with too many open files. */
const ACCEPT_RETRY_MS = 1000;

/** Wait `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read one JSON line. A stream chunk can hold only part of a UTF-8 character or a message. */
export async function readFrame(connection: UnixConnection): Promise<unknown> {
  const reader = connection.readable.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the peer closed before the message ended");

      text += decoder.decode(chunk.value, { stream: true });

      const end = text.indexOf("\n");
      if (end !== -1) return JSON.parse(text.slice(0, end));
      if (text.length > MAX_FRAME) throw new Error("the message is too large");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Write one JSON line. Each connection carries one request and one response. */
export function writeFrame(connection: UnixConnection, value: unknown): Promise<void> {
  return connection.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
}

/** Send one request and read its result. A successful response does not mean that an agent finished its work. */
export async function request(path: string, value: unknown, signal: AbortSignal): Promise<unknown> {
  using connection = await connect({ path, signal });
  await writeFrame(connection, value);

  const response = await readFrame(connection);
  if (typeof response !== "object" || response === null) throw new Error("the peer returned an invalid response");
  if ("error" in response && typeof response.error === "string") throw new Error(response.error);
  if (!("result" in response)) throw new Error("the peer returned no result");

  return response.result;
}

/** Answer one request. A failure of the handler goes back to the peer as its error. */
async function answer(connection: UnixConnection, handle: (value: unknown) => Promise<unknown>): Promise<void> {
  using held = connection;

  let response: unknown;
  try {
    response = { result: await handle(await readFrame(held)) };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }

  await writeFrame(held, response);
}

/**
 * Serve requests until the signal aborts or the returned stop runs.
 * The abort closes the listener, removes its socket file, and closes the accepted connections.
 */
export function serve(
  path: string,
  signal: AbortSignal,
  handle: (value: unknown) => Promise<unknown>,
  report: (error: unknown) => void,
): () => Promise<void> {
  const controller = new AbortController();
  const stopping = AbortSignal.any([signal, controller.signal]);
  const listener = listen({ path, signal: stopping });
  const tasks = new Set<Promise<void>>();

  const accepting = (async () => {
    while (!stopping.aborted) {
      let connection: UnixConnection;
      try {
        connection = await listener.accept();
      } catch (error) {
        if (stopping.aborted || (error instanceof ConnectionError && error.code === "ERR_CLOSED")) return;

        // A failed accept leaves the listener open. Without the retry, the endpoint would stay listed but never answer.
        report(error);
        await sleep(ACCEPT_RETRY_MS);
        continue;
      }

      const task = answer(connection, handle)
        .catch((error: unknown) => {
          if (!stopping.aborted) report(error);
        })
        .finally(() => tasks.delete(task));
      tasks.add(task);
    }
  })();

  return async () => {
    controller.abort();
    await accepting;
    await Promise.all(tasks);
  };
}
