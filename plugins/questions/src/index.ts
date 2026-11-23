/**
 * The plugin `questions`. The tool `ask_user` queues questions for the user and returns at once, so the agent works on.
 * The status bar counts the questions of the focused session. `/questions` asks the oldest request in the question view
 * of yuke. The answers go to the agent as a notification. Esc keeps the request for later.
 */

import type { PluginContext, SessionContext } from "yuke:plugins";
import type { Question, QuestionAnswer } from "yuke:protocol";

/** One call of `ask_user`: its questions wait for the user. */
interface Request {
  readonly id: string;
  readonly questions: readonly Question[];
}

/** The requests of one open session, and the way to ask its user. */
interface Queue {
  readonly ask: SessionContext["ask"];
  readonly requests: Request[];
}

// `apply` and `session` run in one runtime, so the tool and the command share the queues.
const queues = new Map<string, Queue>();
const listeners = new Set<() => void>();
let requestCount = 0;

function changed(): void {
  for (const listener of listeners) listener();
}

/** The text that the agent reads: each question with its answer. */
function answerText(request: Request, answers: readonly QuestionAnswer[]): string {
  const lines = request.questions.map((question) => {
    const answer = answers.find((candidate) => candidate.id === question.id);
    const parts = [...(answer?.values ?? [])];
    if (answer?.other !== undefined) parts.push(answer.other);
    return `- ${question.header}: ${question.question}\n  Answer: ${parts.length === 0 ? "(none)" : parts.join("; ")}`;
  });
  return `The user answered the questions of ${request.id}:\n${lines.join("\n")}`;
}

export function apply(ctx: PluginContext): undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;
  const chat = ctx.get("chat");
  const sessions = ctx.get("sessions");
  let removeItem: (() => void) | undefined;
  let answering = false;

  const focusedSession = (): string | undefined => {
    const view = tui.panes.activePane?.view;
    return view === undefined ? undefined : chat.sessionIdOf(view);
  };
  const show = (): void => {
    const id = focusedSession();
    const count = id === undefined ? 0 : (queues.get(id)?.requests.length ?? 0);
    removeItem?.();
    removeItem =
      count === 0
        ? undefined
        : tui.status.set("waiting", { text: `Questions ${count}`, side: "right", order: 2, priority: 2 });
  };
  listeners.add(show);
  ctx.signal.addEventListener("abort", () => listeners.delete(show), { once: true });
  chat.addChangeListener(show);
  tui.addFocusListener(show);

  tui.commands.add({
    name: "answer",
    description: "Answer the oldest questions of the agent in this session",
    slash: "questions",
    run: () => {
      const id = focusedSession();
      const queue = id === undefined ? undefined : queues.get(id);
      const request = queue?.requests[0];
      if (id === undefined || queue === undefined || request === undefined) {
        ctx.notify("info", "No questions wait in this session");
        return;
      }
      if (answering) return;
      answering = true;
      void (async () => {
        try {
          const answers = await queue.ask({ questions: request.questions }, { signal: ctx.signal });
          // A cancel keeps the request for later.
          if (answers === undefined) return;
          queue.requests.splice(queue.requests.indexOf(request), 1);
          changed();
          using handle = await sessions.open(id, { tail: 0, signal: ctx.signal, onEvent: () => {} });
          const headers = request.questions.map((question) => question.header).join(", ");
          await handle.notifyModel({ display: `Answered: ${headers}`, text: answerText(request, answers) });
        } catch (error) {
          ctx.notify("error", `The answers did not reach the agent: ${String(error)}`);
        } finally {
          answering = false;
        }
      })();
    },
  });
  return undefined;
}

const option = {
  type: "object",
  properties: {
    label: { type: "string", minLength: 1 },
    description: { type: "string" },
  },
  required: ["label"],
} as const;

export function session(s: SessionContext): undefined {
  const queue: Queue = { ask: s.ask, requests: [] };
  queues.set(s.sessionId, queue);
  s.signal.addEventListener(
    "abort",
    () => {
      if (queues.get(s.sessionId) === queue) queues.delete(s.sessionId);
      changed();
    },
    { once: true },
  );
  s.tools.add({
    name: "ask_user",
    description:
      "Queue one to four questions for the user, and go on at once. The user answers later, and the answers arrive as a notification from the plugin questions. Use it for a decision that only the user can make while other work can go on. Do not assume an answer, and do not ask the same question again while it waits. Give options when the answers are known. The user can always type an answer of their own, so do not add an Other option.",
    concurrency: "serial",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              header: { type: "string", minLength: 1, description: "A short name of the question, such as Database." },
              question: { type: "string", minLength: 1 },
              options: { type: "array", maxItems: 8, items: option },
              multiple: { type: "boolean", description: "The user can choose more than one option." },
            },
            required: ["header", "question"],
          },
        },
      },
      required: ["questions"],
    },
    execute: async (args) => {
      const questions: Question[] = args.questions.map((question, index) => {
        const labels = (question.options ?? []).map((choice) => choice.label);
        if (new Set(labels).size !== labels.length)
          throw new Error(`The options of "${question.header}" repeat a label.`);
        return {
          id: `q${index + 1}`,
          header: question.header,
          question: question.question,
          options: (question.options ?? []).map((choice) =>
            choice.description === undefined
              ? { label: choice.label }
              : { label: choice.label, description: choice.description },
          ),
          ...(question.multiple === true ? { multiple: true } : {}),
          other: true,
        };
      });
      requestCount += 1;
      const request: Request = { id: `questions-${requestCount}`, questions };
      queue.requests.push(request);
      changed();
      return JSON.stringify({
        id: request.id,
        status: "queued",
        message:
          "Not answered yet. The answers arrive later as a notification. Go on with the work that does not need them.",
      });
    },
  });
  return undefined;
}
