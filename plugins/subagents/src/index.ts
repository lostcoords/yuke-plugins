import type { JobReport, PluginContext, SessionContext, SessionHandle, Sessions } from "yuke:plugins";
import type { InputId, SessionId, SessionRow, SessionSettings } from "yuke:protocol";
import type { ToolContext, ToolResult } from "yuke:tools";
import type { Tui } from "yuke:tui";
import type { ListEntry } from "./list.ts";
import { ModelList, modelId, resolveModel } from "./models.ts";
import { type LoggedRun, RunLog } from "./run-log.ts";
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

If you cannot finish, or you need a decision, say so in your final message. The parent can answer you.`;

/** The count of the newest events that a report reads. The last commits of a turn hold its final message. */
const REPORT_EVENTS = 16;

/** A subagent whose job runs. */
interface Running extends ListEntry {
  readonly handle: SessionHandle;
  /** The open parent, which also stops the job. */
  readonly parent: SessionHandle;
  /** The inputs of the job. */
  readonly inputs: InputId[];
}

let sessions: Sessions;

/** The terminal interface, or `undefined` in `yuke --rpc` and `yuke -p`. */
let tui: Tui | undefined;

/** The running subagents of each parent session. A follow-up during a run needs the open session of that run. */
const runs = new Map<SessionId, Map<SessionId, Running>>();

/** Each subagent that this process knows. It stays after a close, because a pane can still show that subagent. */
const subagents = new Map<SessionId, { readonly parent: SessionId; readonly label: string | undefined }>();

/** The parents with a running turn. */
const busy = new Set<SessionId>();

/** The one view of a parent while any subagent of the parent runs. */
interface ParentView {
  runs: number;
  readonly ended: AbortController;
  readonly handle: Promise<SessionHandle>;
}

/** The view of each parent. A view for each run would copy each update of the parent once for each run. */
const parentViews = new Map<SessionId, ParentView>();

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
      [...(runs.get(parent)?.entries() ?? [])].map(([id, run]) => ({
        id,
        label: run.label,
        model: run.model,
        started: run.started,
        stop: () => run.parent.stopJob(id),
      })),
    busy: (parent) => busy.has(parent),
    anyRunning: () => [...runs.values()].some((running) => running.size > 0),
    readOnly: (session) => {
      const subagent = subagents.get(session);
      if (subagent === undefined) return undefined;
      const label = subagent.label;
      return { text: label === undefined ? "Subagent" : `Subagent: ${label}`, back: subagent.parent };
    },
  });
}

export async function session(s: SessionContext): Promise<undefined> {
  if (s.parent !== undefined) {
    // A pane can open a subagent of an earlier process, which has no label here.
    if (!subagents.has(s.sessionId)) subagents.set(s.sessionId, { parent: s.parent, label: undefined });
    s.addHook("prompt.build", (event) => ({ sections: { ...event.sections, subagent: SUBAGENT_PROMPT } }));
    return;
  }
  // The tool text is fixed for the session, so the prompt cache holds. A new list reaches the next session.
  const ids = await readyIds(s);
  await tellInterrupted(s);
  const running = new Map<SessionId, Running>();
  runs.set(s.sessionId, running);
  s.signal.addEventListener("abort", () => {
    runs.delete(s.sessionId);
    busy.delete(s.sessionId);
  });

  s.tools.add({
    name: "spawn_subagent",
    description: SPAWN_DESCRIPTION,
    concurrency: "parallel",
    parameters: {
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
    hints: { subject: { argument: "description", kind: "text" } },
    async execute(args, context) {
      const settings = await settingsOf(s, (args as { readonly model?: string }).model);
      const id = await sessions.create(settings, { parent: s.sessionId });
      return run(s, context, running, id, args.description, args.message, args.background, settings.model.model);
    },
  });

  s.tools.add({
    name: "message_subagent",
    description: MESSAGE_DESCRIPTION,
    concurrency: "parallel",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the subagent." },
        message: { type: "string", description: "The message." },
        background: { type: "boolean", description: BACKGROUND_DESCRIPTION },
      },
      required: ["id", "message", "background"],
    },
    hints: { subject: { argument: "message", kind: "text" } },
    async execute(args, context) {
      const row = await rowOf(args.id);
      if (row?.session.parent !== s.sessionId) {
        throw new Error(`The id ${args.id} names no subagent of this session.`);
      }
      const active = running.get(args.id);
      if (active === undefined) {
        const model = row.session.model.model;
        return run(s, context, running, args.id, args.message, args.message, args.background, model);
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
  let lost: readonly LoggedRun[];
  try {
    lost = await log.read(s.sessionId);
  } catch (error) {
    // A kill during a write can damage the file. The file goes, so the next open does not repeat this error.
    s.notify("error", `the running subagents did not load: ${String(error)}`);
    await log.clear(s.sessionId);
    return;
  }
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

/** The row of the session `id`, or `undefined` when no session has that id, also for a malformed id. */
async function rowOf(id: string): Promise<SessionRow | undefined> {
  try {
    return await sessions.get(id);
  } catch {
    return undefined;
  }
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
    cwd: s.settings.cwd,
  };
}

/** Run the turn of the subagent `id` for `message` as a job, and give the result of the call. */
async function run(
  s: SessionContext,
  context: ToolContext,
  running: Map<SessionId, Running>,
  id: SessionId,
  label: string,
  message: string,
  background: boolean,
  model: string,
): Promise<ToolResult> {
  subagents.set(id, { parent: s.sessionId, label });
  const job = { id, label, background };
  const outcome = await context.jobs.run(job, (signal) => work(s, running, id, label, model, message, signal));
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

/** Count one more run on the view of the parent `s`, and open the view for the first run. */
function holdParent(s: SessionContext): ParentView {
  let view = parentViews.get(s.sessionId);
  if (view === undefined) {
    const ended = new AbortController();
    // After its turn ends, a session with a job and no holder closes after `sessionIdleMinutes`.
    // The close stops the job.
    const handle = sessions.open(s.sessionId, {
      tail: 0,
      signal: ended.signal,
      onEvent(event) {
        const updates = "snapshot" in event ? event.snapshot.updates : [event.update];
        for (const update of updates) {
          if (update.sessionUpdate !== "state") continue;
          if (update.state === "idle") busy.delete(s.sessionId);
          else busy.add(s.sessionId);
          redraw();
        }
      },
    });
    view = { runs: 0, ended, handle };
    parentViews.set(s.sessionId, view);
  }
  view.runs += 1;
  return view;
}

/** End one run on `view`. The last run ends the view. */
function releaseParent(parent: SessionId, view: ParentView): void {
  view.runs -= 1;
  if (view.runs > 0) return;
  parentViews.delete(parent);
  view.ended.abort();
}

/** Send `message` to the subagent `id`, wait for its end, and give its report. The host drops the report after a stop. */
async function work(
  s: SessionContext,
  running: Map<SessionId, Running>,
  id: SessionId,
  label: string,
  model: string,
  message: string,
  signal: AbortSignal,
): Promise<JobReport> {
  const ended = new AbortController();
  const view = holdParent(s);
  try {
    const parent = await view.handle;
    const handle: SessionHandle = await sessions.open(id, {
      tail: 0,
      signal: ended.signal,
      onEvent(event) {
        if ("snapshot" in event || event.update.sessionUpdate !== "interactionRequested") return;
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
      parent,
      inputs: [await handle.sendMessage({ content: [{ kind: "userText", text: message }] })],
      label,
      model,
      started: tui?.now() ?? 0,
    };
    running.set(id, active);
    await log.add(s.sessionId, { id, label });
    redraw();
    // A stop can come during the waits above, and an abort event does not fire again.
    if (signal.aborted) void stop(active);
    else signal.addEventListener("abort", () => void stop(active));
    await handle.waitForIdle();
    return await reportOf(id, before);
  } finally {
    running.delete(id);
    redraw();
    releaseParent(s.sessionId, view);
    ended.abort();
    // A close or a reload leaves the run in the log, so the next process tells about it. A crash also leaves it.
    if (!s.signal.aborted) await log.remove(s.sessionId, [id]);
  }
}

/** Remove the pending inputs, so that no new turn starts, and cancel the turn. */
async function stop(active: Running): Promise<void> {
  try {
    for (const id of active.inputs) await active.handle.removeInput(id);
    active.handle.cancel();
  } catch {
    // The session closed first, so no turn remains to stop.
  }
}

/** The report of the session `id` from the events after `before`: its status, and its final message. */
async function reportOf(id: SessionId, before: number): Promise<JobReport> {
  const events = await sessions.events(id, { limit: REPORT_EVENTS });
  const commits = events.flatMap((event) =>
    event.sessionUpdate === "commit" && event.seq > before ? [event.commit] : [],
  );
  // A failed hook leaves the input pending and saves no commit.
  if (commits.length === 0) return { status: "failed", text: "The subagent did not start. A notice tells why." };
  const end = commits.at(-1)?.end;
  const failure = end?.kind === "failed" ? end.error : undefined;
  const texts = commits.map((commit) =>
    commit.blocks.flatMap((block) => (block.kind === "assistantText" ? [block.text] : [])).join(""),
  );
  const text = texts.findLast((candidate) => candidate !== "") ?? "";
  if (failure !== undefined) return { status: "failed", text: text === "" ? failure : `${failure}\n${text}` };
  // A stop drops this report, so it reaches the parent only after a cancel with no stop. A quit can do that.
  if (end?.kind === "cancelled") {
    const note = "A cancel ended the subagent before it finished.";
    return { status: "cancelled", text: text === "" ? note : `${note}\n${text}` };
  }
  return { status: "completed", text: text === "" ? "The subagent ended without a final message." : text };
}
