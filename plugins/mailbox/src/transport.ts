import { connect, listen, type UnixConnection } from "yuke:net";

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

/** Serve requests until the signal aborts or the returned cleanup runs. Accepted connections stop with the listener. */
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
      const connection = await listener.accept();
      const task = (async () => {
        using held = connection;
        try {
          let response: unknown;
          try {
            response = { result: await handle(await readFrame(held)) };
          } catch (error) {
            response = { error: error instanceof Error ? error.message : String(error) };
          }
          await writeFrame(held, response);
        } catch (error) {
          if (!stopping.aborted) report(error);
        }
      })();
      tasks.add(task);
      task.then(() => tasks.delete(task)).catch(report);
    }
  })().catch((error: unknown) => {
    if (!stopping.aborted) report(error);
  });

  return async () => {
    try {
      listener.close();
    } finally {
      controller.abort();
      await accepting;
      await Promise.all(tasks);
    }
  };
}
