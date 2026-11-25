import type { JobReport, PluginContext, SessionContext, SessionHandle, Sessions } from "yuke:plugins";
import type { InputId, SessionId, SessionSettings } from "yuke:protocol";
import type { ToolContext, ToolExecuteResult } from "yuke:tools";
import type { Tui } from "yuke:tui";
import type { ListEntry } from "./list.ts";
import { ModelList, modelId, resolveModel } from "./models.ts";
import { RunLog } from "./run-log.ts";
import { installUi } from "./ui.ts";

const SPAWN_DESCRIPTION = `Start a subagent: a new agent with its own context, the same tools, and the same folder as you. It cannot start subagents.

A subagent costs time and tokens: it starts with no context, explores again, and you then read its report. Always use it when the user or project instructions ask. Otherwise, use it only for work that is independent and large enough to justify a new context, or that is naturally parallel. When in doubt, do the work yourself.

Do not use it for:
- A task that takes a handful of tool calls: a few reads, one search, a short edit, a single check.
- A check of work that you can verify yourself.
- One modest task split into parts.
- A modest research question, even across several sources.

Brief it like a smart colleague who has not seen this conversation:
- Explain the goal and why it matters.
- Describe what you already learned or ruled out.
- Name the files that matter.
- Say whether it should change files or only research.

After you start a subagent, do not read, research, or check the material of its task until its report arrives. This rule also covers other tool calls in the answer that starts the subagent.

The user does not see the report of a background subagent, so summarize what matters. A report says what the subagent meant to do, so check its changes before you call the work done. Give each subagent that writes files a separate set of files.`;

const MESSAGE_DESCRIPTION =
  "Send a message to a subagent by its id: a follow-up after it ended, or a new instruction while it runs. It keeps its context. The background rule of spawn_subagent applies.";

const BACKGROUND_DESCRIPTION =
  "Run in the background and return at once. Set it to false only when your next step depends on the result.";

const WAIT_RULE = "Its final message arrives as a notification, so do not sleep, poll, or guess the result.";

const LEAVE_RULE =
  "Do not do its task, and avoid its files and topics. Work on something else, or tell the user what you started and end your turn. If the user asks before the notification arrives, say that the subagent still runs.";

const SUBAGENT_PROMPT = `You are a subagent working on one task from a parent agent. You have not seen the conversation of the parent, so rely on its message and your tools. Complete the task fully, without extras.

The parent reads only your final message, not files that you create. Put your findings there: what you did, what you found, and the absolute paths of the files that matter. Include code only when the exact text matters. Keep it concise.

If you cannot finish, or you need a decision, say so in your final message. The parent can answer you.

Your final message stops your background commands, so run each command that you need in the foreground.`;

/** The count of the newest events that a report reads. The last commits of a turn hold its final message. */
const REPORT_EVENTS = 16;

/** A subagent whose job runs. */
interface Running extends ListEntry {
  readonly handle: SessionHandle;
  /** The parent session. */
  readonly parentId: SessionId;
  /** The open parent, which also stops the job. */
  readonly parentHandle: SessionHandle;
  /** The inputs of the job. */
  readonly inputs: InputId[];
}

let sessions: Sessions;

/** The terminal interface, or `undefined` in `yuke --rpc` and `yuke -p`. */
let tui: Tui | undefined;

/** The running subagents by their ids, oldest first. A follow-up during a run needs the open session of that run. */
const runs = new Map<SessionId, Running>();

/** The label of each subagent that this process knows. It stays after a close, because the chat can still show it. */
const subagents = new Map<SessionId, string | undefined>();

/** The one hold of a parent while any subagent of the parent runs. It keeps the parent open, and it stops the jobs. */
interface ParentHold {
  /** The count of runs on this hold. */
  count: number;
  readonly ended: AbortController;
  readonly handle: Promise<SessionHandle>;
}

/** The hold of each parent. */
const parentHolds = new Map<SessionId, ParentHold>();

/** Draw the interface again. */
let redraw = (): void => {};

/** The list of models that the user chose. */
let models: ModelList;

/** The runs that a later process must see. */
let log: RunLog;

export function apply(ctx: PluginContext): undefined {
  sessions = ctx.get("sessions");
  models = new ModelList(ctx.dataDir, ctx.get("catalog"));
  log = new RunLog(ctx.dataDir);
  tui = ctx.get("tui");
  if (tui === undefined) return;
  redraw = installUi(ctx, tui, models, {
    running: (parent) =>
      [...runs.entries()]
        .filter(([, run]) => run.parentId === parent)
        .map(([id, run]) => ({
          id,
          label: run.label,
          model: run.model,
          started: run.started,
          stop: () => run.parentHandle.stopJob(id),
        })),
    anyRunning: () => runs.size > 0,
    label: (session) => {
      if (!subagents.has(session)) return undefined;
      const label = subagents.get(session);
      return label === undefined ? "Subagent" : `Subagent: ${label}`;
    },
  });
}

export async function session(s: SessionContext): Promise<undefined> {
  if (s.parent !== undefined) {
    // The chat can open a subagent of an earlier process, which has no label here.
    if (!subagents.has(s.sessionId)) subagents.set(s.sessionId, undefined);
    s.addHook("prompt.build", (event) => ({ sections: { ...event.sections, subagent: SUBAGENT_PROMPT } }));
    return;
  }
  // The tool text is fixed for the session, so the prompt cache holds. A new list reaches the next session.
  const ids = await readyIds(s);
  await tellInterrupted(s);

  s.tools.add({
    name: "spawn_subagent",
    description: SPAWN_DESCRIPTION,
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "A label of 3 to 5 words for the user." },
        message: { type: "string", description: "The brief of the subagent." },
        background: { type: "boolean", description: BACKGROUND_DESCRIPTION },
        ...(ids.length === 0
          ? {}
          : { model: { type: "string", enum: ids, description: "Omit it to use the default of the user." } as const }),
      },
      required: ["description", "message", "background"],
    },
    hints: { title: "Subagent", subject: { argument: "description", kind: "text" } },
    async execute(args, context) {
      // The schema has `model` only when the list of models is not empty, so the type of `args` lacks it.
      const settings = await settingsOf(s, (args as { readonly model?: string }).model);
      const id = await sessions.create(settings, { parent: s.sessionId });
      return run(s, context, id, args.description, args.message, args.background, settings.model.model);
    },
  });

  s.tools.add({
    name: "message_subagent",
    description: MESSAGE_DESCRIPTION,
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the subagent." },
        message: { type: "string", description: "The message." },
        background: { type: "boolean", description: BACKGROUND_DESCRIPTION },
      },
      required: ["id", "message", "background"],
    },
    hints: { title: "Message subagent", subject: { argument: "message", kind: "text" } },
    async execute(args, context) {
      // An id of no session, also a malformed one, rejects, and names no subagent.
      const row = await sessions.get(args.id).catch(() => undefined);
      if (row?.parent !== s.sessionId) {
        throw new Error(`The id ${args.id} names no subagent of this session.`);
      }
      const active = runs.get(args.id);
      if (active === undefined) {
        // A subagent of an earlier process has no label here, so its message names it.
        const label = subagents.get(args.id) ?? args.message;
        return run(s, context, args.id, label, args.message, args.background, row.model.model);
      }
      active.inputs.push(await active.handle.sendMessage({ content: [{ kind: "userText", text: args.message }] }));
      return {
        text: `Subagent ${args.id} still runs and has the message. ${WAIT_RULE}`,
        display: [{ kind: "markdown", text: "Message sent" }],
      };
    },
  });
}

/**
 * Tell about the subagents of this session that an earlier process left running: the user now, and the model with the
 * next input. A wake of the model would spend tokens when the user only opens an old session.
 */
async function tellInterrupted(s: SessionContext): Promise<void> {
  const lost = await log.read(s.sessionId);
  if (lost.length === 0) return;
  for (const run of lost) s.notify("warn", `${run.label} · interrupted`);
  const remove = s.addHook("input.before", async (event) => {
    remove();
    await log.remove(
      s.sessionId,
      lost.map((run) => run.id),
    );
    const lines = lost.map(
      (run) =>
        `Subagent ${run.id} (${run.label}) stopped when yuke closed, and it has no report. Use message_subagent to continue it, or start the work again.`,
    );
    const text = `<system_notification plugin="subagents">${lines.join("\n")}</system_notification>`;
    return { replace: { blocks: [{ kind: "userText", text }, ...event.blocks] } };
  });
}

/** The ids of the saved models with a ready provider. A broken file gives a notice and no `model` argument. */
async function readyIds(s: SessionContext): Promise<string[]> {
  try {
    const providers = await models.providers();
    const saved = await models.read();
    return saved.models.filter((entry) => resolveModel(entry, providers) !== undefined).map(modelId);
  } catch (error) {
    s.notify("error", `the subagent models did not load: ${String(error)}`);
    return [];
  }
}

/** The settings of a new subagent: the model `chosen`, else the default of the user, else the session model. */
async function settingsOf(s: SessionContext, chosen: string | undefined): Promise<SessionSettings> {
  const saved = await models.read();
  const id = chosen ?? saved.default;
  if (id === undefined) return s.settings;
  const entry = saved.models.find((candidate) => modelId(candidate) === id);
  const resolved = entry === undefined ? undefined : resolveModel(entry, await models.providers());
  if (resolved === undefined) {
    throw new Error(
      `The subagent model ${id} is not available. Ask the user to change the list with subagents:models.`,
    );
  }
  return {
    model: resolved.model,
    settings: { ...s.settings.settings, reasoning: resolved.reasoning },
    folder: s.settings.folder,
  };
}

/** Run the turn of the subagent `id` for `message` as a job, and give the result of the call. */
async function run(
  s: SessionContext,
  context: ToolContext,
  id: SessionId,
  label: string,
  message: string,
  background: boolean,
  model: string,
): Promise<ToolExecuteResult> {
  subagents.set(id, label);
  const job = { id, label, background };
  const outcome = await context.jobs.run(job, (signal) => work(s, id, label, model, message, signal));
  if (outcome.kind === "background") {
    return {
      text: `Subagent ${id} runs in the background. ${WAIT_RULE}\n${LEAVE_RULE}`,
      display: [{ kind: "markdown", text: background ? "Running in the background" : "Moved to the background" }],
    };
  }
  const report = outcome.report;
  const text = report?.text ?? "";
  return {
    text: `Subagent ${id}:\n\n${text}`,
    display: [{ kind: "markdown", text }],
    isError: report?.status === "failed",
  };
}

/** Count one more run on the hold of the parent `s`, and open the hold for the first run. */
function holdParent(s: SessionContext): ParentHold {
  let hold = parentHolds.get(s.sessionId);
  if (hold === undefined) {
    const ended = new AbortController();
    // After its turn ends, a session with a job and no holder closes after `sessionIdleMinutes`.
    // The close stops the job.
    const handle = sessions.open(s.sessionId, { tail: 0, signal: ended.signal, onEvent() {} });
    hold = { count: 0, ended, handle };
    parentHolds.set(s.sessionId, hold);
  }
  hold.count += 1;
  return hold;
}

/** End one run on `hold`. The last run ends the hold. */
function releaseParent(parent: SessionId, hold: ParentHold): void {
  hold.count -= 1;
  if (hold.count > 0) return;
  parentHolds.delete(parent);
  hold.ended.abort();
}

/** Send `message` to the subagent `id`, wait for its end, and give its report. The host drops the report after a stop. */
async function work(
  s: SessionContext,
  id: SessionId,
  label: string,
  model: string,
  message: string,
  signal: AbortSignal,
): Promise<JobReport> {
  const ended = new AbortController();
  const hold = holdParent(s);
  try {
    const parent = await hold.handle;
    const handle: SessionHandle = await sessions.open(id, {
      tail: 0,
      signal: ended.signal,
      onEvent(event) {
        if (event.kind === "snapshot" || event.update.kind !== "interactionRequested") return;
        const update = event.update;
        // A subagent has no user, so the parent asks its user.
        void s.ask({ questions: update.request.questions }, { signal: ended.signal }).then((answers) => {
          // The end of the job closes the question and the handle.
          if (handle.signal.aborted) return;
          handle.respond(
            update.interactionId,
            answers === undefined ? { kind: "cancelled" } : { kind: "questions", answers },
          );
        });
      },
    });
    // The report reads only the events of this job.
    const before = (await sessions.events(id, { limit: 1 })).at(-1)?.seq ?? 0;
    const active: Running = {
      handle,
      parentId: s.sessionId,
      parentHandle: parent,
      inputs: [await handle.sendMessage({ content: [{ kind: "userText", text: message }] })],
      label,
      model,
      started: tui?.now() ?? 0,
    };
    runs.set(id, active);
    await log.add(s.sessionId, { id, label });
    redraw();
    // A stop can come during the waits above, and an abort event does not fire again.
    if (signal.aborted) void stop(active);
    else signal.addEventListener("abort", () => void stop(active));
    await handle.waitForIdle();
    // The close below stops the jobs that the subagent leaves, so the report names them.
    const left = handle.jobs().map((job) => job.label);
    const report = await reportOf(id, before);
    if (left.length === 0) return report;
    return { ...report, text: `${report.text}\n\nThe end of the subagent stopped its jobs: ${left.join(", ")}.` };
  } finally {
    runs.delete(id);
    redraw();
    releaseParent(s.sessionId, hold);
    ended.abort();
    // A close stops the background commands of the subagent. A later message opens the session again.
    // It rejects when the session is not open or a reload runs. The idle close then ends the session.
    await sessions.closeForAll(id).catch(() => undefined);
    // A close or a reload leaves the run in the log, so the next process tells about it. A crash also leaves it.
    if (!s.signal.aborted) await log.remove(s.sessionId, [id]);
  }
}

/** Remove the pending inputs, so that no new turn starts, and cancel the turn. */
async function stop(active: Running): Promise<void> {
  try {
    for (const id of active.inputs) await active.handle.removeInput(id);
    active.handle.cancelTurn();
  } catch {
    // The session closed first, so no turn remains to stop.
  }
}

/** The report of the session `id` from the events after `before`: its status, and its final message. */
async function reportOf(id: SessionId, before: number): Promise<JobReport> {
  const events = await sessions.events(id, { limit: REPORT_EVENTS });
  const commits = events.flatMap((event) => (event.kind === "commit" && event.seq > before ? [event.commit] : []));
  // A failed hook leaves the input pending and saves no commit.
  if (commits.length === 0) return { status: "failed", text: "The subagent did not start. A notice tells why." };
  const end = commits.at(-1)?.end;
  const failure = end?.kind === "failed" ? end.error : undefined;
  const texts = commits.map((commit) =>
    commit.blocks.flatMap((block) => (block.kind === "assistantText" ? [block.text] : [])).join(""),
  );
  const text = texts.findLast((candidate) => candidate !== "") ?? "";
  const withNote = (note: string): string => (text === "" ? note : `${note}\n${text}`);
  if (failure !== undefined) return { status: "failed", text: withNote(failure) };
  // A stop drops this report, so it reaches the parent only after a cancel with no stop. A quit can do that.
  if (end?.kind === "cancelled") {
    return { status: "cancelled", text: withNote("A cancel ended the subagent before it finished.") };
  }
  return { status: "completed", text: text === "" ? "The subagent ended without a final message." : text };
}
