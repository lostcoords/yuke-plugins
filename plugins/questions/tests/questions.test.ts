import type { QuestionAnswer } from "yuke:protocol";
import type { TestQuestion } from "yuke:test";
import { assert, assertEquals, createFrame, createHost, reply, test, waitForSettled } from "yuke:test";
import { apply, session } from "../src/index.ts";

const ASK = {
  questions: [
    {
      header: "Database",
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite", description: "One file" }],
    },
    { header: "Name", question: "What is the project name?" },
  ],
};

test("ask_user returns at once, and /questions asks later, keeps a cancelled request, and sends the answers", async () => {
  using frame = createFrame({ width: 80, height: 20 });
  const tui = frame.surface("questions").tui;
  let shown: string | undefined;
  const asked: TestQuestion[] = [];
  const answers: (readonly QuestionAnswer[] | undefined)[] = [
    undefined,
    [
      { id: "q1", values: ["SQLite"] },
      { id: "q2", values: [], other: "yuke" },
    ],
  ];
  await using host = await createHost({
    plugins: [
      {
        name: "chat",
        provides: ["chat"],
        apply(ctx) {
          ctx.provide("chat", {
            sessionIdOf: () => shown,
            addChangeListener: () => () => {},
          } as never);
        },
      },
      {
        name: "questions",
        uses: ["chat"],
        apply: (ctx) =>
          apply({ ...ctx, get: ((name: string) => (name === "tui" ? tui : ctx.get(name as never))) as never }),
        session,
      },
    ],
    replies: [reply.text("Thanks.")],
    onQuestion: (question) => {
      asked.push(question);
      return answers.shift();
    },
  });
  const chatSession = await host.openSession();
  shown = chatSession.id;
  tui.panes.split(() => ({ draw: () => {} }));
  const waiting = () => tui.status.list().find((item) => item.id === "questions:waiting")?.text;

  const result = await chatSession.call("ask_user", ASK);
  assertEquals(JSON.parse(result.text).status, "queued");
  // The call asked nobody, so the agent goes on.
  assertEquals([asked.length, waiting()], [0, "Questions 1"]);

  assert(tui.commands.run("questions:answer"));
  await waitForSettled();
  assertEquals(asked.length, 1);
  assertEquals(
    asked[0]?.request.questions.map((question) => [question.id, question.header, question.other]),
    [
      ["q1", "Database", true],
      ["q2", "Name", true],
    ],
  );
  assertEquals([waiting(), host.requests.length], ["Questions 1", 0]);

  assert(tui.commands.run("questions:answer"));
  await waitForSettled();
  assertEquals(asked.length, 2);
  assertEquals(waiting(), undefined);
  for (let attempt = 0; attempt < 50 && host.requests.length === 0; attempt += 1) await waitForSettled();
  const request = JSON.stringify(host.requests.at(-1));
  assert(request.includes("Answer: SQLite") && request.includes("Answer: yuke"), request);
});

test("an option label that repeats fails the call, and /questions with no request says so", async () => {
  using frame = createFrame({ width: 80, height: 20 });
  const tui = frame.surface("questions").tui;
  let shown: string | undefined;
  await using host = await createHost({
    plugins: [
      {
        name: "chat",
        provides: ["chat"],
        apply(ctx) {
          ctx.provide("chat", { sessionIdOf: () => shown, addChangeListener: () => () => {} } as never);
        },
      },
      {
        name: "questions",
        uses: ["chat"],
        apply: (ctx) =>
          apply({ ...ctx, get: ((name: string) => (name === "tui" ? tui : ctx.get(name as never))) as never }),
        session,
      },
    ],
  });
  const chatSession = await host.openSession();
  shown = chatSession.id;
  tui.panes.split(() => ({ draw: () => {} }));
  const result = await chatSession.call("ask_user", {
    questions: [{ header: "Mode", question: "Which mode?", options: [{ label: "fast" }, { label: "fast" }] }],
  });
  assert(result.isError && result.text.includes("repeat a label"), result.text);
  assert(tui.commands.run("questions:answer"));
  await waitForSettled();
  assert(host.notices.some((notice) => notice.text === "No questions wait in this session"));
});
