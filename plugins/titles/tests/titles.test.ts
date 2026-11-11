import { writeTextFile } from "yuke:fs";
import type { ServiceOf, Services, Sessions } from "yuke:plugins";
import { assert, createHost, equal, type Reply, reply, waitForSettled, test } from "yuke:test";
import { firstMessage, Titles } from "../src/titles.ts";

const PRIMARY = { model: "anthropic/claude-fable-5", reasoning: "default" };
const FALLBACK = { model: "openai/gpt-4.1", reasoning: "default" };

async function waitFor(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; !(await done()); attempt++) {
    if (attempt === 200) throw new Error("The expected title state did not arrive.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Hold main rounds so each test can observe the independent title request first. */
async function opened(replies: readonly Reply[], models = [PRIMARY], renameWhileGenerating = false) {
  let titles: Titles | undefined;
  let sessions: Sessions | undefined;
  let main = Promise.withResolvers<void>();
  const host = await createHost({
    plugins: [
      {
        name: "titles",
        async apply(ctx) {
          sessions = ctx.get("sessions");
          await writeTextFile(`${ctx.dataDir}/settings.json`, JSON.stringify({ models }));
          const service = sessions;
          let reads = 0;
          const watched = {
            ...service,
            get: async (id: string) => {
              reads++;
              if (renameWhileGenerating && reads === 2) await service.rename(id, "My manual title");
              return service.get(id);
            },
          };
          titles = new Titles({
            ...ctx,
            get: <K extends keyof Services & string>(name: K): ServiceOf<K> =>
              name === "sessions" ? (watched as ServiceOf<K>) : ctx.get(name),
          });
          return () => titles?.close();
        },
        session(s) {
          s.hook("round.before", async () => {
            await main.promise;
            return undefined;
          });
        },
      },
    ],
    replies,
  });
  assert(titles !== undefined && sessions !== undefined);
  const session = await host.openSession();
  const service = sessions;
  const title = async () => (await service.get(session.id)).session.title;
  return {
    host,
    session,
    titles,
    sessions,
    title,
    release: () => main.resolve(),
    hold: () => {
      main = Promise.withResolvers<void>();
    },
  };
}

test("the first user message gets a short title without changing conversation history", async () => {
  const state = await opened([
    reply.text("Fix login refresh"),
    reply.text("The refresh is fixed."),
    reply.text("Done."),
  ]);
  await using host = state.host;
  const running = state.session.send("Can you fix login after the access token expires?");
  await waitFor(async () => (await state.title()) === "Fix login refresh");
  state.release();
  await running;
  await state.session.send("Check the tests too.");

  equal(await state.title(), "Fix login refresh");
  equal(host.requests.length, 3);
  equal(
    [host.requests[0]?.tools, host.requests[0]?.messages],
    [[], [{ role: "user", text: "Can you fix login after the access token expires?" }]],
  );
  equal((host.requests[0]?.body as { model: string } | undefined)?.model, "claude-fable-5");
  equal((host.requests[1]?.body as { model: string } | undefined)?.model, "MiniMax-M3");
  equal(host.requests[2]?.messages, [
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
  const running = state.session.send("Fix the token refresh.");
  await waitFor(async () => (await state.title()) === "Repair token refresh");
  state.release();
  await running;

  equal(await state.title(), "Repair token refresh");
  equal(
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
  const running = state.session.send("Repair the login bug.");
  await waitFor(async () => (await state.title()) === "Repair login");
  state.release();
  await running;

  equal(await state.title(), "Repair login");
  equal(
    host.requests.map((request) => (request.body as { model: string }).model),
    ["claude-fable-5", "gpt-4.1", "MiniMax-M3"],
  );
});

test("an empty model list leaves automatic naming off and later settings work without a reload", async () => {
  const state = await opened([reply.text("First answer."), reply.text("Review API changes")], []);
  await using host = state.host;
  state.release();
  await state.session.send("First task.");
  equal([await state.title(), host.requests.length], ["First task.", 1]);

  await state.titles.models.write({ models: [PRIMARY] });
  await state.titles.regenerate(state.session.id);
  equal(await state.title(), "Review API changes");
  equal(host.requests.length, 2);
});

test("manual names and child sessions keep their titles", async () => {
  const state = await opened([reply.text("First answer."), reply.text("Child answer.")]);
  await using host = state.host;
  await state.sessions.rename(state.session.id, "My chosen title");
  state.release();
  await state.session.send("Fix login.");
  const childId = await state.sessions.create(state.session.settings, { parent: state.session.id });
  const controller = new AbortController();
  const child = await state.sessions.open(childId, { tail: 0, signal: controller.signal, onEvent() {} });
  try {
    await child.sendMessage([{ user_text: "Review login." }]);
    await child.waitForIdle();
    equal((await state.sessions.get(childId)).session.title, "Review login.");
  } finally {
    controller.abort();
  }
  equal([await state.title(), host.requests.length], ["My chosen title", 2]);
});

test("all failed title models retain the initial title and leave the main answer usable", async () => {
  const state = await opened(
    [reply.failed("primary failed"), reply.failed("fallback failed"), reply.text("Main answer.")],
    [PRIMARY, FALLBACK],
  );
  await using host = state.host;
  const running = state.session.send("Fix the broken login.");
  await waitFor(() => host.notices.some((notice) => notice.message.includes("The session title did not change")));
  state.release();
  await running;

  equal([await state.title(), host.requests.length], ["Fix the broken login.", 3]);
  equal(
    state.session.transcript.entries.filter((entry) => entry.kind === "text").map((entry) => entry.text),
    ["Main answer."],
  );
});

test("a stalled title does not delay the main answer and closing cancels it without a fallback", async () => {
  const state = await opened([reply.stall("Partial"), reply.text("Main answer.")], [PRIMARY, FALLBACK]);
  await using host = state.host;
  const running = state.session.send("Fix login.");
  await waitFor(() => host.requests.length === 1);
  state.release();
  await running;
  await state.session.close();
  await state.titles.close();

  equal(host.requests.length, 2);
  equal(
    state.session.transcript.entries.filter((entry) => entry.kind === "text").map((entry) => entry.text),
    ["Main answer."],
  );
});

test("notifications do not name sessions and the first displayed message supplies regeneration", async () => {
  const state = await opened([reply.text("Noted."), reply.text("Original request title"), reply.text("Main answer.")]);
  await using host = state.host;
  state.release();
  const controller = new AbortController();
  const handle = await state.sessions.open(state.session.id, { tail: 0, signal: controller.signal, onEvent() {} });
  try {
    await handle.notifyModel("Background job finished.", "A job finished.");
    await handle.waitForIdle();
    equal([await state.title(), host.requests.length], [undefined, 1]);
    // The displayed request, not the expanded model-only prompt, supplies the title.
    state.hold();
    await handle.sendMessage([{ user_text: "Explain this API." }], [{ user_text: "Expanded private instructions." }]);
    await waitFor(async () => (await state.title()) === "Original request title");
    state.release();
    await handle.waitForIdle();
    equal((await firstMessage(state.sessions, state.session.id))?.text, "Explain this API.");
    equal(host.requests.find((request) => request.tools.length === 0)?.messages, [
      { role: "user", text: "Explain this API." },
    ]);
  } finally {
    controller.abort();
  }
});

test("a manual rename made during generation takes precedence over the generated title", async () => {
  const state = await opened([reply.text("Generated title"), reply.text("Main answer.")], [PRIMARY], true);
  await using host = state.host;
  const running = state.session.send("Fix login.");
  await waitFor(async () => (await state.title()) === "My manual title");
  await waitForSettled();
  equal(await state.title(), "My manual title");
  state.release();
  await running;
  await state.titles.close();

  equal([await state.title(), host.requests.length], ["My manual title", 2]);
});
