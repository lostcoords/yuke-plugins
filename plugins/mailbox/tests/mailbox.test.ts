import { readDir, readTextFile, writeTextFile } from "yuke:fs";
import type { Sessions } from "yuke:plugins";
import { assert, createHost, equal, type Reply, reply, test } from "yuke:test";
import { apply as subagentsApply, session as subagentsSession } from "../../subagents/src/index.ts";
import { apply, session } from "../src/index.ts";
import type { Peer } from "../src/mailbox.ts";

interface Listing {
  readonly self: string;
  readonly agents: readonly Peer[];
}

/** Open the real plugin on a host with a scripted model. */
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
  assert(sessions !== undefined);
  return { host, first, sessions, dataDir };
}

/** Read the result as an agent does, and fail if the call failed. */
async function list(agent: Awaited<ReturnType<typeof opened>>["first"]): Promise<Listing> {
  const result = await agent.call("mailbox_list_agents", {});
  equal(result.isError, false);
  return JSON.parse(result.text) as Listing;
}

test("agents discover other open sessions with their current titles and folders, but not themselves", async () => {
  const state = await opened();
  await using host = state.host;
  const second = await host.openSession();
  await state.sessions.rename(second.id, "Review the API");
  const other = await list(second);
  const result = await list(state.first);
  equal(
    result.agents.map((agent) => [agent.sessionId, agent.title, agent.folder, agent.activity]),
    [[second.id, "Review the API", second.settings.cwd, "idle"]],
  );
  equal(result.agents[0]?.id, other.self);
  equal(
    other.agents.map((agent) => agent.id),
    [result.self],
  );
});

test("a direct message wakes an idle session and reaches the model as an agent notification", async () => {
  const state = await opened([reply.text("Noted.")]);
  await using host = state.host;
  const second = await host.openSession();
  const target = (await list(second)).self;
  const from = (await list(state.first)).self;
  const result = await state.first.call("mailbox_send_message", {
    to: target,
    message: "The migration is ready.\nUse tenant_id.",
  });
  equal(result.isError, false);
  const queued = JSON.parse(result.text) as { status: string; to: string; inputId: number };
  equal([queued.status, queued.to], ["queued", target]);
  assert(Number.isSafeInteger(queued.inputId));
  const controller = new AbortController();
  const handle = await state.sessions.open(second.id, { tail: 0, signal: controller.signal, event() {} });
  try {
    await handle.idle();
  } finally {
    controller.abort();
  }
  equal(host.requests.length, 1);
  const text = host.requests[0]?.messages.at(-1)?.text ?? "";
  assert(text.includes("Message from another Yuke session, not the user."), text);
  const line = text.split("\n").at(-1)?.replace("</system_notification>", "") ?? "";
  const incoming = JSON.parse(line) as { from: Peer; message: string };
  equal([incoming.from.id, incoming.message], [from, "The migration is ready.\nUse tenant_id."]);
  equal(
    host.notices.filter((notice) => notice.level === "error"),
    [],
  );
});

test("a closed session leaves discovery and a message to its old address fails", async () => {
  const state = await opened();
  await using host = state.host;
  const second = await host.openSession();
  const target = (await list(second)).self;
  equal(
    (await list(state.first)).agents.map((agent) => agent.sessionId),
    [second.id],
  );
  await second.close();
  equal((await list(state.first)).agents, []);
  const result = await state.first.call("mailbox_send_message", { to: target, message: "Are you there?" });
  equal(result.isError, true);
  assert(result.text.includes("the target session is no longer open"), result.text);
  equal(host.requests.length, 0);
});

test("empty messages and invalid addresses fail before they can queue work", async () => {
  const state = await opened();
  await using host = state.host;
  const second = await host.openSession();
  const target = (await list(second)).self;
  const blank = await state.first.call("mailbox_send_message", { to: target, message: " \n " });
  equal(blank.isError, true);
  assert(blank.text.includes("the message is empty"), blank.text);
  const invalid = await state.first.call("mailbox_send_message", { to: "unknown", message: "Hello" });
  equal(invalid.isError, true);
  assert(invalid.text.includes("the target is not an agent id from mailbox_list_agents"), invalid.text);
  equal(host.requests.length, 0);
});

test("discovery ignores a registry entry whose socket no longer exists", async () => {
  const state = await opened();
  await using host = state.host;
  const second = await host.openSession();
  const target = (await list(second)).self;
  await writeTextFile(`${state.dataDir}/peers/dead.json`, JSON.stringify("/tmp/yuke-mailbox-missing.sock"));
  equal(
    (await list(state.first)).agents.map((agent) => agent.id),
    [target],
  );
});

test("closing the plugin removes its registry entry and its socket file", async () => {
  const state = await opened();
  const records = await readDir(`${state.dataDir}/peers`);
  equal(records.length, 1);
  const path = JSON.parse(await readTextFile(`${state.dataDir}/peers/${records[0]?.name}`)) as string;
  const { lstat } = await import("yuke:fs");
  equal((await lstat(path)).isFile, false);
  await state.host.close();
  equal(await readDir(`${state.dataDir}/peers`), []);
  const { FileSystemError } = await import("yuke:fs");
  const { rejects } = await import("yuke:test");
  const error = await rejects(lstat(path));
  assert(error instanceof FileSystemError);
  equal(error.code, "ENOENT");
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
          s.tools.define({
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
  const running = recipient.send("Start work.");
  try {
    await entered.promise;
    const sent = await sender.call("mailbox_send_message", { to: target, message: "Use the new API." });
    equal(sent.isError, false);
    equal(host.requests.length, 1);
  } finally {
    released.resolve();
    await running;
  }
  equal(host.requests.length, 2);
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
  await first.send("Find the other session.");
  equal(host.requests.length, 3);
  const initial = host.requests[0]?.tools ?? [];
  equal(
    initial
      .filter(
        (name) =>
          name.startsWith("mailbox_") ||
          name === "spawn_subagent" ||
          name === "message_subagent" ||
          name === "tool_call" ||
          name === "tool_search",
      )
      .sort(),
    ["message_subagent", "spawn_subagent", "tool_call", "tool_search"],
  );
  const search = host.requests[1]?.messages.at(-1)?.text ?? "";
  assert(search.includes("mailbox_list_agents"), search);
  assert(search.includes("Input schema:"), search);
  const result = JSON.parse(host.requests[2]?.messages.at(-1)?.text ?? "") as Listing;
  equal(
    result.agents.map((agent) => agent.id),
    [target],
  );
});

test("the coordination hint preserves existing prompt sections and appears once in each turn", async () => {
  const state = await opened([reply.text("First answer."), reply.text("Second answer.")]);
  await using host = state.host;
  const built = await state.first.run("prompt.build", {
    sections: { base: "Keep the user's instructions.", project: "Work only on src/." },
  });
  equal(Object.keys(built.sections), ["base", "project", "mailbox"]);
  equal([built.sections.base, built.sections.project], ["Keep the user's instructions.", "Work only on src/."]);

  await state.first.send("First turn.");
  await state.first.send("Second turn.");
  equal(
    host.requests.map((request) => [
      (request.system.match(/<mailbox>/g) ?? []).length,
      (request.system.match(/<\/mailbox>/g) ?? []).length,
    ]),
    [
      [1, 1],
      [1, 1],
    ],
  );
  equal(
    host.requests.map((request) => request.tools.filter((name) => name.startsWith("mailbox_"))),
    [[], []],
  );
});
