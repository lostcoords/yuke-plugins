import type { ChatService } from "yuke:chat";
import { writeTextFile } from "yuke:fs";
import type { Sessions } from "yuke:plugins";
import {
  assert,
  assertEquals,
  createFrame,
  createHost,
  folder,
  type PluginUnderTest,
  type Reply,
  reply,
  test,
  waitForSettled,
} from "yuke:test";
import { Titles } from "../src/titles.ts";
import { withServices } from "./support.ts";

const PRIMARY = { model: "anthropic/claude-fable-5", reasoning: "default" };
const FALLBACK = { model: "openai/gpt-4.1", reasoning: "default" };

/** A plugin that holds each main round, so a test observes the independent title request first. */
function mainRoundGate() {
  let gate = Promise.withResolvers<void>();
  const plugin: PluginUnderTest = {
    name: "gate",
    session(session) {
      session.addHook("round.before", async () => {
        await gate.promise;
        return undefined;
      });
    },
  };
  return {
    plugin,
    release: () => gate.resolve(),
    hold: () => {
      gate = Promise.withResolvers<void>();
    },
  };
}

/** The real plugin, with `models` in its settings file, and a session whose main rounds wait for `release`. */
async function opened(replies: readonly Reply[], models = [PRIMARY], frame?: ReturnType<typeof createFrame>) {
  const dataDir = folder();
  await writeTextFile("settings.json", JSON.stringify({ models }), { folder: dataDir });
  const gate = mainRoundGate();
  let sessions: Sessions | undefined;
  let chat: ChatService | undefined;
  const host = await createHost({
    ...(frame === undefined ? {} : { frame }),
    plugins: [
      { bundled: "chat" },
      { folder: `${import.meta.dirname}/..`, dataDir },
      gate.plugin,
      {
        name: "probe",
        uses: ["chat"],
        apply(ctx) {
          sessions = ctx.get("sessions");
          chat = ctx.get("chat");
        },
      },
    ],
    replies,
  });
  assert(sessions !== undefined && chat !== undefined);
  const session = await host.openSession();
  const service = sessions;
  return {
    host,
    session,
    sessions,
    chat,
    title: async () => (await service.get(session.id)).title,
    release: gate.release,
    hold: gate.hold,
  };
}

test("the first user message gets a short title without changing conversation history", async () => {
  const state = await opened([
    reply.text("Fix login refresh"),
    reply.text("The refresh is fixed."),
    reply.text("Done."),
  ]);
  await using host = state.host;
  const running = state.session.sendMessage("Can you fix login after the access token expires?");
  await waitForSettled();
  assertEquals(await state.title(), "Fix login refresh");
  state.release();
  await running;
  await state.session.sendMessage("Check the tests too.");

  assertEquals(await state.title(), "Fix login refresh");
  assertEquals(host.requests.length, 3);
  assertEquals(
    [host.requests[0]?.tools, host.requests[0]?.messages],
    [[], [{ role: "user", text: "Can you fix login after the access token expires?" }]],
  );
  assertEquals((host.requests[0]?.body as { model: string } | undefined)?.model, "claude-fable-5");
  assertEquals((host.requests[1]?.body as { model: string } | undefined)?.model, "MiniMax-M3");
  assertEquals(host.requests[2]?.messages, [
    { role: "user", text: "Can you fix login after the access token expires?" },
    { role: "assistant", text: "The refresh is fixed." },
    { role: "user", text: "Check the tests too." },
  ]);
});

test("a failed primary request tries the next chosen model", async () => {
  const state = await opened(
    [reply.failed("unavailable"), reply.text("Repair token refresh"), reply.text("Fixed.")],
    [PRIMARY, FALLBACK],
  );
  await using host = state.host;
  const running = state.session.sendMessage("Fix the token refresh.");
  await waitForSettled();
  assertEquals(await state.title(), "Repair token refresh");
  state.release();
  await running;

  assertEquals(await state.title(), "Repair token refresh");
  assertEquals(
    host.requests.map((request) => (request.body as { model: string }).model),
    ["claude-fable-5", "gpt-4.1", "MiniMax-M3"],
  );
});

test("an overlong title falls back and unavailable configured models do not use the session model", async () => {
  const state = await opened(
    [reply.text("x".repeat(81)), reply.text("Repair login"), reply.text("Fixed.")],
    [{ model: "missing/not-a-model", reasoning: "default" }, PRIMARY, FALLBACK],
  );
  await using host = state.host;
  const running = state.session.sendMessage("Repair the login bug.");
  await waitForSettled();
  assertEquals(await state.title(), "Repair login");
  state.release();
  await running;

  assertEquals(await state.title(), "Repair login");
  assertEquals(
    host.requests.map((request) => (request.body as { model: string }).model),
    ["claude-fable-5", "gpt-4.1", "MiniMax-M3"],
  );
});

test("manual names and child sessions keep their titles", async () => {
  const state = await opened([reply.text("First answer."), reply.text("Child answer.")]);
  await using host = state.host;
  await state.sessions.rename(state.session.id, "My chosen title");
  state.release();
  await state.session.sendMessage("Fix login.");
  const childId = await state.sessions.create(state.session.settings, { parent: state.session.id });
  const controller = new AbortController();
  const child = await state.sessions.open(childId, { tail: 0, signal: controller.signal, onEvent() {} });
  try {
    await child.sendMessage({ content: [{ kind: "userText", text: "Review login." }] });
    await child.waitForIdle();
    assertEquals((await state.sessions.get(childId)).title, "Review login.");
  } finally {
    controller.abort();
  }
  assertEquals([await state.title(), host.requests.length], ["My chosen title", 2]);
});

test("all failed title models retain the initial title and leave the main answer usable", async () => {
  const state = await opened(
    [reply.failed("primary failed"), reply.failed("fallback failed"), reply.text("Main answer.")],
    [PRIMARY, FALLBACK],
  );
  await using host = state.host;
  const running = state.session.sendMessage("Fix the broken login.");
  await waitForSettled();
  assert(host.notices.some((notice) => notice.text.includes("The session title did not change")));
  state.release();
  await running;

  assertEquals([await state.title(), host.requests.length], ["Fix the broken login.", 3]);
  assertEquals(
    state.session.transcript.entries.filter((entry) => entry.kind === "text").map((entry) => entry.text),
    ["Main answer."],
  );
});

test("a stalled title does not delay the main answer and closing cancels it without a fallback", async () => {
  const state = await opened([reply.stall("Partial"), reply.text("Main answer.")], [PRIMARY, FALLBACK]);
  await using host = state.host;
  const running = state.session.sendMessage("Fix login.");
  await waitForSettled();
  assertEquals(host.requests.length, 1);
  state.release();
  await running;
  await state.session.close();
  await waitForSettled();

  assertEquals(host.requests.length, 2);
  assertEquals(
    state.session.transcript.entries.filter((entry) => entry.kind === "text").map((entry) => entry.text),
    ["Main answer."],
  );
});

test("notifications do not name sessions and regeneration uses the first displayed message", async () => {
  using frame = createFrame({ width: 100, height: 24 });
  const tui = frame.surface("test").tui;
  const state = await opened(
    [
      reply.text("Noted."),
      reply.text("Original request title"),
      reply.text("Main answer."),
      reply.text("Second title"),
    ],
    [PRIMARY],
    frame,
  );
  await using host = state.host;
  frame.start();
  state.release();
  const controller = new AbortController();
  const handle = await state.sessions.open(state.session.id, { tail: 0, signal: controller.signal, onEvent() {} });
  try {
    await handle.notifyModel({ display: "Background job finished.", text: "A job finished." });
    await handle.waitForIdle();
    assertEquals([await state.title(), host.requests.length], [undefined, 1]);
    // The displayed request, not the expanded model-only prompt, supplies the title.
    state.hold();
    await handle.sendMessage({
      content: [{ kind: "userText", text: "Explain this API." }],
      modelContent: [{ kind: "userText", text: "Expanded private instructions." }],
    });
    await waitForSettled();
    assertEquals(await state.title(), "Original request title");
    state.release();
    await handle.waitForIdle();

    await state.chat.show(state.session.id);
    assertEquals(tui.commands.run("titles:regenerate"), true);
    await waitForSettled();
    assertEquals(await state.title(), "Second title");
    assertEquals(
      host.requests
        .filter((request) => (request.body as { model: string }).model === "claude-fable-5")
        .map((request) => request.messages),
      [[{ role: "user", text: "Explain this API." }], [{ role: "user", text: "Explain this API." }]],
    );
  } finally {
    controller.abort();
  }
});

test("a manual rename made during generation takes precedence over the generated title", async () => {
  const gate = mainRoundGate();
  let titles: Titles | undefined;
  let sessions: Sessions | undefined;
  await using host = await createHost({
    plugins: [
      {
        name: "titles",
        async apply(ctx) {
          const real = ctx.get("sessions");
          sessions = real;
          await writeTextFile(`${ctx.dataDir}/settings.json`, JSON.stringify({ models: [PRIMARY] }));
          let reads = 0;
          // The second read is the one that follows the title request. A rename lands before it.
          const watched: Sessions = {
            ...real,
            get: async (id) => {
              reads++;
              if (reads === 2) await real.rename(id, "My manual title");
              return real.get(id);
            },
          };
          titles = new Titles(withServices(ctx, { sessions: watched }));
          return () => titles?.close();
        },
      },
      gate.plugin,
    ],
    replies: [reply.text("Generated title"), reply.text("Main answer.")],
  });
  assert(sessions !== undefined);
  const session = await host.openSession();
  const running = session.sendMessage("Fix login.");
  await waitForSettled();
  assertEquals((await sessions.get(session.id)).title, "My manual title");
  gate.release();
  await running;

  assertEquals([(await sessions.get(session.id)).title, host.requests.length], ["My manual title", 2]);
});
