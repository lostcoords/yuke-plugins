import { FileSystemError, lstat, mkdir, readDir, remove, writeTextFile } from "yuke:fs";
import { listen } from "yuke:net";
import type { Sessions } from "yuke:plugins";
import { assert, assertEquals, assertRejects, createHost, type Reply, reply, type TestSession, test } from "yuke:test";
import { apply as subagentsApply, session as subagentsSession } from "../../subagents/src/index.ts";
import { apply, session } from "../src/index.ts";
import { type Agent, agentId, type Sender } from "../src/mailbox.ts";
import { serve } from "../src/transport.ts";

interface Listing {
  readonly self: string;
  readonly agents: readonly Agent[];
}

/** Open the real plugin on a host with a scripted model, with two top-level sessions. */
async function opened(replies: readonly Reply[] = []) {
  let sessions: Sessions | undefined;
  let dataDir = "";

  const host = await createHost({
    plugins: [
      {
        name: "mailbox",
        apply(ctx) {
          sessions = ctx.get("sessions");
          dataDir = ctx.dataDir;
          return apply(ctx);
        },
        session,
      },
    ],
    replies,
  });

  const first = await host.openSession();
  const second = await host.openSession();
  assert(sessions !== undefined);

  return { host, first, second, sessions, dataDir, target: agentId(second.settings.cwd, second.id) };
}

/** Read the result as an agent does, and fail if the call failed. */
async function list(agent: TestSession): Promise<Listing> {
  const result = await agent.call("mailbox_list_agents", {});
  assertEquals(result.isError, false);

  return JSON.parse(result.text) as Listing;
}

/** Send as an agent does. */
function send(agent: TestSession, to: string, message: string) {
  return agent.call("mailbox_send_message", { to, message });
}

/** Check that a call failed with `text` in its error. */
function failed(result: { readonly isError: boolean; readonly text: string }, text: string): void {
  assertEquals(result.isError, true);
  assert(result.text.includes(text), result.text);
}

/** Wait until the session `id` handled its queued inputs. */
async function idle(sessions: Sessions, id: string): Promise<void> {
  const controller = new AbortController();
  const handle = await sessions.open(id, { tail: 0, signal: controller.signal, onEvent() {} });
  try {
    await handle.waitForIdle();
  } finally {
    controller.abort();
  }
}

/** Whether `path` exists, without following a link. */
async function exists(path: string): Promise<boolean> {
  const error = await lstat(path).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (error instanceof FileSystemError && error.code === "ENOENT") return false;
  if (error !== undefined) throw error;

  return true;
}

/**
 * A registry entry and socket folder as another process would make them, for `serve` or a raw listener.
 * Its runtime id sorts before the real one, so a send tries it first. Disposal removes both.
 */
async function endpoint(dataDir: string) {
  const runtime = `0test${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const folder = `/tmp/yuke-mailbox-${runtime}`;
  const entry = `${dataDir}/peers/${runtime}.json`;

  await mkdir(folder, { mode: 0o700 });
  await writeTextFile(entry, "");

  return {
    entry,
    folder,
    socket: `${folder}/socket`,
    async [Symbol.asyncDispose]() {
      await remove(entry, { force: true });
      await remove(folder, { recursive: true, force: true });
    },
  };
}

/** Serve `handle` at `socket`, as the endpoint of another process would. Disposal stops it. */
function serving(socket: string, handle: (value: unknown) => Promise<unknown>) {
  const stop = serve(socket, new AbortController().signal, handle, () => {});
  return { [Symbol.asyncDispose]: stop };
}

test("an agent id is the folder name and four characters of the random end of the session id", () => {
  const sessionId = "019a5c2e-1111-7222-8333-00000000abcd";

  assertEquals(agentId("/Users/me/Work/yuke-plugins", sessionId), "yuke-plugins-0xxp");
  assertEquals(agentId("/Users/me/Work/My Project!/", sessionId), "my-project-0xxp");
  assertEquals(agentId("/", sessionId), "session-0xxp");
  assertEquals(agentId("/srv/日本語", sessionId), "session-0xxp");

  // Sessions of the same moment share the start of the id, so only the end tells them apart.
  assertEquals(agentId("/w/api", "019a5c2e-1111-7222-8333-000000000001") === agentId("/w/api", sessionId), false);
});

test("agents discover other open sessions with their ids, current titles and folders, but not themselves", async () => {
  const state = await opened();
  await using _host = state.host;
  await state.sessions.rename(state.second.id, "Review the API");

  const other = await list(state.second);
  const result = await list(state.first);

  const folder = state.second.settings.cwd;
  assertEquals(result.agents, [{ id: state.target, title: "Review the API", folder, activity: "idle" }]);
  assertEquals(other.self, state.target);
  assertEquals(
    other.agents.map((agent) => agent.id),
    [result.self],
  );
});

test("a direct message wakes an idle session and reaches the model as an agent notification", async () => {
  const state = await opened([reply.text("Noted.")]);
  await using host = state.host;
  await state.sessions.rename(state.first.id, "Plan the database migration for the tenants");
  const from = (await list(state.first)).self;

  const result = await send(state.first, state.target, "The migration is ready.\nUse tenant_id.");
  assertEquals(result.isError, false);
  assertEquals(JSON.parse(result.text), { status: "queued", to: state.target });

  await idle(state.sessions, state.second.id);
  assertEquals(host.requests.length, 1);

  // The user sees the id and a short title.
  const shown = state.second.transcript.entries.find(
    (entry) => entry.kind === "input" && entry.source.kind === "plugin",
  );
  assert(shown?.kind === "input");
  assertEquals(shown.content, [
    {
      kind: "userText",
      text: `Message from ${from} (Plan the database migration for the ten…): The migration is ready.\nUse tenant_id.`,
    },
  ]);

  // The model reads the whole sender as JSON.
  const text = host.requests[0]?.messages.at(-1)?.text ?? "";
  assert(text.includes("Message from another Yuke session, not the user."), text);

  const line = text.split("\n").at(-1)?.replace("</system_notification>", "") ?? "";
  assertEquals(JSON.parse(line) as { from: Sender; message: string }, {
    from: { id: from, title: "Plan the database migration for the tenants", folder: state.first.settings.cwd },
    message: "The migration is ready.\nUse tenant_id.",
  });

  assertEquals(
    host.notices.filter((notice) => notice.level === "error"),
    [],
  );
});

test("child sessions have no mailbox and do not appear in discovery", async () => {
  const state = await opened([reply.text("Done.")]);
  await using host = state.host;

  const child = await state.sessions.create(state.first.settings, { parent: state.first.id });
  const controller = new AbortController();
  const handle = await state.sessions.open(child, { tail: 0, signal: controller.signal, onEvent() {} });

  try {
    assertEquals(
      (await list(state.first)).agents.map((agent) => agent.id),
      [state.target],
    );

    await handle.sendMessage({ content: [{ kind: "userText", text: "Work on the task." }] });
    await handle.waitForIdle();
  } finally {
    controller.abort();
  }

  assertEquals(host.requests.length, 1);
  assertEquals(host.requests[0]?.system.includes("<mailbox>"), false);
});

test("a closed session leaves discovery and a message to its old id fails", async () => {
  const state = await opened();
  await using host = state.host;

  await state.second.close();
  assertEquals((await list(state.first)).agents, []);

  failed(await send(state.first, state.target, "Are you there?"), "the target session is no longer open");
  assertEquals(host.requests.length, 0);
});

test("empty messages, invalid ids, and the own id fail before they can queue work", async () => {
  const state = await opened();
  await using host = state.host;

  failed(await send(state.first, state.target, " \n "), "the message is empty");

  for (const to of ["unknown", "mw1t346z-558vu2wdbbm/019a5c2e-1111-7222-8333-00000000abcd", "Yuke-0xxp"]) {
    failed(await send(state.first, to, "Hello"), "the target is not an agent id from mailbox_list_agents");
  }

  failed(await send(state.first, (await list(state.first)).self, "Hello"), "the target is your own id");
  assertEquals(host.requests.length, 0);
});

test("discovery removes the entry and socket folder of an endpoint that died without closing", async () => {
  const state = await opened();
  await using _host = state.host;
  await using dead = await endpoint(state.dataDir);

  // A file that is not an entry stays.
  await writeTextFile(`${state.dataDir}/peers/notes.txt`, "keep");

  assertEquals(
    (await list(state.first)).agents.map((agent) => agent.id),
    [state.target],
  );

  assertEquals(await exists(dead.entry), false);
  assertEquals(await exists(dead.folder), false);
  assertEquals(await exists(`${state.dataDir}/peers/notes.txt`), true);
});

test("an endpoint that never answers is skipped after a timeout and stays registered", async () => {
  const state = await opened();
  await using _host = state.host;
  await using hung = await endpoint(state.dataDir);

  // The kernel queues the connection, but nothing accepts it, as with a process suspended by Ctrl-Z.
  using _listener = listen({ path: hung.socket });

  const started = Date.now();
  assertEquals(
    (await list(state.first)).agents.map((agent) => agent.id),
    [state.target],
  );

  assert(Date.now() - started < 5000);
  assertEquals(await exists(hung.entry), true);
});

test("an endpoint with a broken answer is skipped without breaking discovery", async () => {
  const state = await opened();
  await using _host = state.host;
  await using broken = await endpoint(state.dataDir);
  await using _server = serving(broken.socket, async () => [{ id: 42 }]);

  assertEquals(
    (await list(state.first)).agents.map((agent) => agent.id),
    [state.target],
  );

  assert(state.host.notices.some((notice) => notice.level === "debug" && notice.text.includes("skipped")));
});

test("during a reload the same session from two endpoints is one agent, and a send reaches it", async () => {
  const state = await opened([reply.text("Noted.")]);
  await using host = state.host;
  await using closing = await endpoint(state.dataDir);

  // The endpoint of the old runtime lists the same session, but it closes and refuses to deliver.
  const listed = { id: state.target, sessionId: state.second.id, title: null, folder: "/", activity: "idle" };
  await using _server = serving(closing.socket, async (value) => {
    if ((value as { method: string }).method === "list") return [listed];
    throw new Error("the target session is no longer open");
  });

  assertEquals(
    (await list(state.first)).agents.map((agent) => agent.id),
    [state.target],
  );

  assertEquals((await send(state.first, state.target, "After the reload.")).isError, false);

  await idle(state.sessions, state.second.id);
  assertEquals(host.requests.length, 1);
});

test("two different sessions with the same id refuse a send instead of guessing", async () => {
  const state = await opened();
  await using host = state.host;
  await using other = await endpoint(state.dataDir);

  const listed = { id: state.target, sessionId: "another-session", title: null, folder: "/", activity: "idle" };
  await using _server = serving(other.socket, async () => [listed]);

  failed(await send(state.first, state.target, "Hello"), "more than one session has this id");

  assertEquals(host.requests.length, 0);
});

test("the socket lives in a private folder that closing removes with the registry entry", async () => {
  const state = await opened();

  const entries = await readDir(`${state.dataDir}/peers`);
  assertEquals(entries.length, 1);

  const folder = `/tmp/yuke-mailbox-${entries[0]?.name.replace(/\.json$/, "")}`;
  assertEquals((await lstat(`${folder}/socket`)).isFile, false);

  await state.host.close();

  assertEquals(await readDir(`${state.dataDir}/peers`), []);
  const error = await assertRejects(() => lstat(folder));
  assert(error instanceof FileSystemError);
  assertEquals(error.code, "ENOENT");
});

test("a message to a busy session waits for its running tool and reaches the next model round", async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  const host = await createHost({
    plugins: [
      {
        name: "mailbox",
        apply,
        session(s) {
          session(s);
          s.tools.add({
            name: "hold",
            description: "Wait for the test.",
            concurrency: "serial",
            parameters: { type: "object", properties: {} },
            async execute(_args, context) {
              entered.resolve();
              await Promise.race([
                released.promise,
                new Promise<void>((resolve) =>
                  context.signal.addEventListener("abort", () => resolve(), { once: true }),
                ),
              ]);
              return "the tool finished";
            },
          });
        },
      },
    ],
    replies: [reply.toolCall("hold", {}), reply.text("I read the update.")],
  });
  await using _host = host;

  const recipient = await host.openSession();
  const sender = await host.openSession();
  const target = (await list(recipient)).self;

  const running = recipient.sendMessage("Start work.");
  try {
    await entered.promise;
    assertEquals((await send(sender, target, "Use the new API.")).isError, false);
    assertEquals(host.requests.length, 1);
  } finally {
    released.resolve();
    await running;
  }

  assertEquals(host.requests.length, 2);
  const messages = host.requests[1]?.messages.map((message) => message.text).join("\n") ?? "";
  assert(messages.includes("the tool finished"), messages);
  assert(messages.includes('"message":"Use the new API."'), messages);
});

test("mailbox tools stay deferred beside subagent tools and discovery works through tool search", async () => {
  await using host = await createHost({
    plugins: [
      { name: "subagents", apply: subagentsApply, session: subagentsSession },
      { name: "mailbox", apply, session },
    ],
    replies: [
      reply.toolCall("tool_search", { query: "mailbox_list_agents", limit: 1 }),
      reply.toolCall("tool_call", { name: "mailbox_list_agents", arguments: {} }),
      reply.text("I found the peer."),
    ],
  });

  const first = await host.openSession();
  const second = await host.openSession();
  const target = (await list(second)).self;

  await first.sendMessage("Find the other session.");
  assertEquals(host.requests.length, 3);

  const initial = host.requests[0]?.tools ?? [];
  assertEquals(
    initial.some((name) => name.startsWith("mailbox_")),
    false,
  );
  assert(initial.includes("spawn_subagent") && initial.includes("tool_search"), initial.join(", "));

  const search = host.requests[1]?.messages.at(-1)?.text ?? "";
  assert(search.includes("mailbox_list_agents"), search);
  assert(search.includes("Input schema:"), search);

  const result = JSON.parse(host.requests[2]?.messages.at(-1)?.text ?? "") as Listing;
  assertEquals(
    result.agents.map((agent) => agent.id),
    [target],
  );
});

test("the coordination hint preserves existing prompt sections and appears once in each turn", async () => {
  const state = await opened([reply.text("First answer."), reply.text("Second answer.")]);
  await using host = state.host;

  const built = await state.first.runHook("prompt.build", {
    sections: { base: "Keep the user's instructions.", project: "Work only on src/." },
  });
  assertEquals(Object.keys(built.sections), ["base", "project", "mailbox"]);
  assertEquals([built.sections.base, built.sections.project], ["Keep the user's instructions.", "Work only on src/."]);

  await state.first.sendMessage("First turn.");
  await state.first.sendMessage("Second turn.");

  const count = (system: string, tag: string) => system.split(tag).length - 1;
  assertEquals(
    host.requests.map((request) => [count(request.system, "<mailbox>"), count(request.system, "</mailbox>")]),
    [
      [1, 1],
      [1, 1],
    ],
  );
  assertEquals(
    host.requests.map((request) => request.tools.filter((name) => name.startsWith("mailbox_"))),
    [[], []],
  );
});
