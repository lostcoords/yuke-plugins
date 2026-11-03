// The tools of the plugin on a test host: reports, follow-ups, stops, moves, questions, and the prompt of a subagent.

import { mkdir, readTextFile, writeTextFile } from "yuke:fs";
import type { PluginApply, PluginSession, QuestionAnswer, SessionContext, Sessions } from "yuke:plugins";
import { createHost, equal, type Reply, reply, settled, test } from "yuke:test";
import { apply, session } from "../src/index.ts";
import type { LoggedRun } from "../src/run-log.ts";

const SPAWN = { description: "Read the store", message: "Read the store.", background: true };

/** What a test changes in `opened`. */
interface Options {
  /** Answers each question of the host. */
  readonly answer?: () => QuestionAnswer[];
  /** Makes `prompt.build` of each subagent fail. */
  readonly failChild?: boolean;
  /** Takes the questions that the plugin asks in the parent. */
  readonly ask?: SessionContext["ask"];
  /** Takes the notices of the plugin. */
  readonly notice?: (text: string) => void;
  /** The runs that an earlier process left in the log of the next parent. */
  readonly runs?: readonly LoggedRun[];
}

/** A host with the plugin and `replies`, and an open parent session. The tool `gate` waits for `openGate`. */
async function opened(replies: readonly Reply[], options: Options = {}) {
  let sessions: Sessions | undefined;
  const gate = Promise.withResolvers<void>();
  // The plugin waits for this promise before each open. A test replaces it to hold the start of a job.
  const opening = { wait: Promise.resolve() };
  let dataDirectory = "";
  const pluginApply: PluginApply = (ctx) => {
    dataDirectory = ctx.dataDir;
    const real = ctx.get("sessions");
    sessions = real;
    const open: Sessions["open"] = async (id, options) => {
      await opening.wait;
      return real.open(id, options);
    };
    return apply({
      ...ctx,
      get: (name: string) => (name === "sessions" ? { ...real, open } : ctx.get(name as never)),
    } as never);
  };
  const pluginSession: PluginSession = async (s) => {
    if (options.failChild === true && s.parent !== undefined) {
      s.hook("prompt.build", () => {
        throw new Error("the hook failed");
      });
    }
    s.tools.define({
      name: "gate",
      description: "Wait for the test.",
      concurrency: "parallel",
      parameters: { type: "object", properties: {} },
      execute: async (_args, context) => {
        const aborted = new Promise((resolve) => context.signal.addEventListener("abort", resolve));
        await Promise.race([gate.promise, aborted]);
        return "open";
      },
    });
    s.tools.define({
      name: "ask",
      description: "Ask the user.",
      concurrency: "serial",
      parameters: { type: "object", properties: {} },
      execute: async (_args, context) =>
        JSON.stringify(
          await s.ask(
            { questions: [{ id: "go", header: "go", question: "Go?", options: [{ label: "Yes" }, { label: "No" }] }] },
            { signal: context.signal },
          ),
        ),
    });
    if (s.parent === undefined && options.runs !== undefined) {
      await mkdir(`${dataDirectory}/running`, { recursive: true });
      await writeTextFile(`${s.sessionId}.json`, JSON.stringify(options.runs), { baseDir: `${dataDirectory}/running` });
    }
    const notify = options.notice;
    const overrides = {
      ...(options.ask === undefined ? {} : { ask: { value: options.ask } }),
      ...(notify === undefined ? {} : { notify: { value: (_level: string, text: string) => notify(text) } }),
    };
    return session(Object.create(s, overrides));
  };
  const host = await createHost({
    plugins: [{ name: "subagents", apply: pluginApply, session: pluginSession }],
    replies,
    ...(options.answer === undefined ? {} : { answer: options.answer }),
  });
  const parent = await host.openSession();
  const list = sessions as unknown as Sessions;
  const handle = await list.open(parent.id, { tail: 0, event() {} });
  return { host, parent, list, handle, openGate: gate.resolve, opening, dataDir: () => dataDirectory };
}

type Opened = Awaited<ReturnType<typeof opened>>;

/** The text of the newest request that the fake model got. */
const newest = (host: Opened["host"]) => host.requests.at(-1)?.messages.at(-1)?.text;

/** The id of the only subagent of the session `parent`. */
async function childOf(opened: Opened): Promise<string> {
  const rows = (await opened.list.list({ parent: opened.parent.id })).sessions;
  equal(rows.length, 1);
  return rows[0]?.session.sessionId as string;
}

/** The notification that the parent reads for the report `text` of the subagent `id`. */
const notification = (id: string, text: string, status = "completed", label = "Read the store") =>
  `<system_notification plugin="subagents">${id} ${label}: ${status}.\n${text}</system_notification>`;

test("a background subagent reports to the parent and stays out of the session list", async () => {
  const state = await opened([reply.text("Two tables."), reply.text("Thanks.")]);
  const { host, parent, list } = state;
  await using _host = host;

  const started = await parent.call("spawn_subagent", SPAWN);
  await settled();
  const id = await childOf(state);
  const roots = (await list.list()).sessions.map((row) => row.session.sessionId);

  equal(started.display, [{ kind: "markdown", text: "Running in the background" }]);
  equal(
    started.text,
    `Subagent ${id} runs in the background. Its final message arrives as a notification, so do not sleep, poll, or guess the result.\nDo not do its task, and avoid its files and topics. Work on something else, or tell the user what you started and end your turn. If the user asks before the notification arrives, say that the subagent still runs.`,
  );
  equal(newest(host), notification(id, "Two tables."));
  equal(roots, [parent.id]);
});

test("a follow-up by id reaches the same subagent, with its context", async () => {
  const state = await opened([
    reply.text("Two tables."),
    reply.text("Thanks."),
    reply.text("Three indexes."),
    reply.text("Thanks again."),
  ]);
  const { host, parent } = state;
  await using _host = host;

  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const id = await childOf(state);
  await parent.call("message_subagent", { id, message: "And the indexes?", background: true });
  await settled();

  const child = host.requests.at(2)?.messages.map((message) => message.text);
  equal(child?.slice(0, 2), ["Read the store.", "Two tables."]);
  equal(child?.at(-1), "And the indexes?");
  equal(newest(host), notification(id, "Three indexes.", "completed", "And the indexes?"));
  equal(await childOf(state), id);
});

test("a foreground subagent gives the model its id and report, shows the user the report, and sends no notification", async () => {
  const state = await opened([reply.text("Two tables.")]);
  const { host, parent, handle } = state;
  await using _host = host;

  const result = await parent.call("spawn_subagent", { ...SPAWN, background: false });
  const id = await childOf(state);

  equal(
    [result.text, result.isError, result.display],
    [`Subagent ${id}:\n\nTwo tables.`, false, [{ kind: "markdown", text: "Two tables." }]],
  );
  equal(handle.jobs(), []);
  equal(host.requests.length, 1);
});

test("a move of a foreground subagent answers the call, and the report reaches the parent", async () => {
  const state = await opened([reply.toolCall("gate", {}), reply.text("Two tables."), reply.text("Thanks.")]);
  const { host, parent, handle, openGate } = state;
  await using _host = host;
  const running = parent.call("spawn_subagent", { ...SPAWN, background: false });
  await settled();

  handle.background();
  const moved = await running;
  const id = await childOf(state);
  const jobs = handle.jobs().map((job) => [job.id, job.label]);
  openGate();
  await settled();

  equal(moved.display, [{ kind: "markdown", text: "Moved to the background" }]);
  equal(moved.text.startsWith(`Subagent ${id} runs in the background. Its final message`), true);
  equal(jobs, [[id, "Read the store"]]);
  equal(newest(host), notification(id, "Two tables."));
});

test("a message during the run joins the turn of the subagent, and the report comes after its answer", async () => {
  const state = await opened([reply.toolCall("gate", {}), reply.text("Three indexes."), reply.text("Thanks.")]);
  const { host, parent, openGate } = state;
  await using _host = host;
  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const id = await childOf(state);

  const sent = await parent.call("message_subagent", { id, message: "And the indexes?", background: true });
  openGate();
  await settled();

  equal(sent.display, [{ kind: "markdown", text: "Message sent" }]);
  equal(newest(host), notification(id, "Three indexes."));
  equal(host.requests[1]?.messages.at(-1)?.text, "open\nAnd the indexes?");
});

test("a stop by id ends the subagent and sends no report", async () => {
  const state = await opened([reply.stall("Reading")]);
  const { host, parent, handle } = state;
  await using _host = host;
  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const id = await childOf(state);

  const stopped = await parent.call("stop", { id });
  await settled();

  equal(stopped.text, `${id} stopped.`);
  equal(handle.jobs(), []);
  equal(host.requests.length, 1);
});

test("a stop while the job starts ends the subagent, and the stop does not hang", async () => {
  const state = await opened([reply.stall("Reading")]);
  const { host, parent, opening } = state;
  await using _host = host;
  const started = Promise.withResolvers<void>();
  opening.wait = started.promise;
  await parent.call("spawn_subagent", SPAWN);
  const id = await childOf(state);

  const stopping = parent.call("stop", { id });
  await settled();
  started.resolve();

  equal((await stopping).text, `${id} stopped.`);
});

test("a stop closes the question of the subagent, and a late answer raises no fault", async () => {
  const late = Promise.withResolvers<QuestionAnswer[] | undefined>();
  let signal: AbortSignal | undefined;
  const state = await opened([reply.toolCall("ask", {})], {
    ask: (_request, options) => {
      signal = options?.signal;
      return late.promise;
    },
  });
  const { host, parent } = state;
  await using _host = host;

  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const stopped = await parent.call("stop", { id: await childOf(state) });
  await settled();
  late.resolve([{ id: "go", values: ["Yes"] }]);
  await settled();

  equal([stopped.isError, signal?.aborted], [false, true]);
});

test("a hook of the subagent that fails reports that the subagent did not start, and no older answer", async () => {
  const state = await opened([reply.text("Noted.")], { failChild: true });
  const { host, parent } = state;
  await using _host = host;

  await parent.call("spawn_subagent", SPAWN);
  await settled();

  equal(newest(host), notification(await childOf(state), "The subagent did not start. A notice tells why.", "failed"));
});

test("the close of the parent stops a subagent that runs", async () => {
  const state = await opened([reply.stall("Reading")]);
  const { host, parent, list } = state;
  await using _host = host;
  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const id = await childOf(state);

  await list.close(parent.id);
  await settled();

  equal((await list.get(id)).activity, "idle");
  equal(host.requests.length, 1);
});

test("a turn without a final message reports that, and not the message of an older turn", async () => {
  const state = await opened([reply.text("Two tables."), reply.text("Thanks."), reply.text(""), reply.text("Noted.")]);
  const { host, parent } = state;
  await using _host = host;

  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const id = await childOf(state);
  await parent.call("message_subagent", { id, message: "And the indexes?", background: true });
  await settled();

  equal(newest(host), notification(id, "The subagent ended without a final message.", "completed", "And the indexes?"));
});

test("a stop drops a message that waits, so no new turn starts", async () => {
  const state = await opened([reply.toolCall("gate", {})]);
  const { host, parent } = state;
  await using _host = host;
  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const id = await childOf(state);
  await parent.call("message_subagent", { id, message: "And the indexes?", background: true });

  await parent.call("stop", { id });
  await settled();

  equal(host.requests.length, 1);
});

test("a question of the subagent reaches the parent, and its answer returns", async () => {
  const state = await opened([reply.toolCall("ask", {}), reply.text("It said yes."), reply.text("Thanks.")], {
    answer: () => [{ id: "go", values: ["Yes"] }],
  });
  const { host, parent } = state;
  await using _host = host;

  await parent.call("spawn_subagent", SPAWN);
  await settled();

  equal(
    host.questions.map((question) => question.sessionId),
    [parent.id],
  );
  equal(newest(host), notification(await childOf(state), "It said yes."));
});

test("a failed turn reports the failure, and a foreground call is an error", async () => {
  const state = await opened([reply.failed("overloaded"), reply.failed("overloaded"), reply.text("Noted.")]);
  const { host, parent } = state;
  await using _host = host;

  const result = await parent.call("spawn_subagent", { ...SPAWN, background: false });
  const id = await childOf(state);
  await parent.call("message_subagent", { id, message: "Try again.", background: true });
  await settled();

  equal(result.isError, true);
  equal(result.text.startsWith(`Subagent ${id}:`) && result.text.includes("overloaded"), true);
  equal(newest(host)?.includes(`${id} Try again.: failed.`), true);
});

test("an id that names no subagent of this session is an error, also the id of the parent", async () => {
  const { host, parent } = await opened([]);
  await using _host = host;

  const unknown = await parent.call("message_subagent", { id: "nope", message: "Hi.", background: true });
  const own = await parent.call("message_subagent", { id: parent.id, message: "Hi.", background: true });

  equal(unknown.text, "The id nope names no subagent of this session.");
  equal(own.text, `The id ${parent.id} names no subagent of this session.`);
  equal([unknown.isError, own.isError], [true, true]);
});

test("two parallel spawns create two subagents", async () => {
  const state = await opened([
    reply.toolCalls([
      { name: "spawn_subagent", args: SPAWN },
      { name: "spawn_subagent", args: SPAWN },
    ]),
    reply.text("Two tables."),
    reply.text("Two tables."),
    reply.text("Waiting."),
    reply.text("Thanks."),
    reply.text("Thanks."),
  ]);
  const { host, parent, list } = state;
  await using _host = host;

  await parent.send("Read the store.");
  await settled();

  equal((await list.list({ parent: parent.id })).sessions.length, 2);
});

/** The running subagents that the log file of `parent` holds. */
async function logged(dataDir: string, parent: string): Promise<readonly string[]> {
  try {
    const text = await readTextFile(`${parent}.json`, { baseDir: `${dataDir}/running` });
    return (JSON.parse(text) as { readonly id: string }[]).map((run) => run.id);
  } catch {
    return [];
  }
}

test("a subagent that ends or stops leaves the log, and a close of the parent keeps it there", async () => {
  const state = await opened([reply.stall("One"), reply.text("Two."), reply.text("Thanks."), reply.stall("Three")]);
  const { host, parent, list, dataDir } = state;
  await using _host = host;

  await parent.call("spawn_subagent", SPAWN);
  await settled();
  const first = await childOf(state);
  const running = await logged(dataDir(), parent.id);
  await parent.call("stop", { id: first });
  await settled();
  const stopped = await logged(dataDir(), parent.id);
  await parent.call("message_subagent", { id: first, message: "Again.", background: true });
  await settled();
  const ended = await logged(dataDir(), parent.id);
  await parent.call("message_subagent", { id: first, message: "Once more.", background: true });
  await settled();
  await list.close(parent.id);
  await settled();

  equal([running, stopped, ended], [[first], [], []]);
  equal(await logged(dataDir(), parent.id), [first]);
});

test("a run from an earlier process gives a notice now, and the model reads it once with the next input", async () => {
  const notices: string[] = [];
  const state = await opened([reply.text("I see."), reply.text("Fine.")], {
    notice: (text) => notices.push(text),
    runs: [{ id: "lost-1", label: "Read the store" }],
  });
  const { host, parent } = state;
  await using _host = host;

  await parent.send("What happened?");
  await settled();
  const told = host.requests[0]?.messages.at(-1)?.text ?? "";
  await parent.send("And now?");
  await settled();

  equal(notices, ["Read the store · interrupted"]);
  equal(told.includes("Subagent lost-1 (Read the store) stopped when yuke closed"), true);
  equal(told.includes("What happened?"), true);
  equal(host.requests[1]?.messages.at(-1)?.text, "And now?");
});

test("a damaged log gives one notice, and the file goes", async () => {
  const notices: string[] = [];
  const state = await opened([], { notice: (text) => notices.push(text), runs: {} as never });
  const { host, parent, dataDir } = state;
  await using _host = host;
  await settled();

  equal(notices.length, 1);
  equal(notices[0]?.includes("not a list"), true);
  equal(await logged(dataDir(), parent.id), []);
});

test("a subagent gets the prompt section and no subagent tools, and the parent gets the tools and no section", async () => {
  const { host, parent } = await opened([reply.text("Two tables."), reply.text("Thanks.")]);
  await using _host = host;

  await parent.call("spawn_subagent", SPAWN);
  await settled();

  const [child, turn] = host.requests;
  equal(child?.system?.includes("You are a subagent working on one task"), true);
  equal(turn?.system?.includes("You are a subagent working on one task"), false);
  equal(child?.tools.includes("spawn_subagent"), false);
  equal(child?.tools.includes("message_subagent"), false);
  equal(turn?.tools.includes("spawn_subagent"), true);
  equal(turn?.tools.includes("message_subagent"), true);
});
