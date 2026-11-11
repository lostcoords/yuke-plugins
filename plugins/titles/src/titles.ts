import { generateText } from "yuke:ai";
import type { Frozen, PluginContext, Sessions } from "yuke:plugins";
import type { Input, InputId, SessionId } from "yuke:protocol";

import { ModelList, modelId, resolveModel } from "./models.ts";

/** The text of a user message, without media or model-only replacements. */
function messageText(input: Pick<Frozen<Input>, "kind" | "source" | "content">): string | undefined {
  if (input.kind !== "message" || input.source.kind !== "user") return undefined;

  const text = input.content
    .flatMap((block) => ("user_text" in block ? [block.user_text] : []))
    .join("\n")
    .trim();

  return text === "" ? undefined : text;
}

/** Read the first user message with text, from the displayed inputs in saved history. */
export async function firstMessage(
  sessions: Sessions,
  id: SessionId,
): Promise<{ readonly id: InputId; readonly text: string } | undefined> {
  let before: number | undefined;
  let first: { readonly id: InputId; readonly text: string } | undefined;

  for (;;) {
    const events = await sessions.events(id, { limit: 100, ...(before === undefined ? {} : { before }) });

    for (const event of [...events].reverse()) {
      if (event.sessionUpdate !== "commit") continue;

      let offset = event.consumed.reduce((count, input) => count + input.blockCount, 0);

      for (const input of [...event.consumed].reverse()) {
        offset -= input.blockCount;
        const content = input.displayContent ?? event.commit.blocks.slice(offset, offset + input.blockCount);

        const text = messageText({ kind: input.kind, source: input.source, content });
        if (text !== undefined) first = { id: input.id, text };
      }
    }

    if (events.length < 100) return first;

    before = events[0]?.seq;
  }
}

/** Generate titles without adding messages, tools, or instructions to the conversation. */
export class Titles {
  readonly models: ModelList;

  readonly #ctx: PluginContext;
  readonly #sessions: Sessions;
  readonly #seen = new Map<SessionId, string>();
  readonly #running = new Map<SessionId, { readonly controller: AbortController; readonly task: Promise<void> }>();
  readonly #remove: (() => void)[];

  constructor(ctx: PluginContext) {
    this.#ctx = ctx;
    this.#sessions = ctx.get("sessions");
    this.models = new ModelList(ctx.dataDir, ctx.get("catalog"));

    this.#remove = [
      ctx.addListener("session.update", (event) => {
        if (event.update.sessionUpdate !== "input_accepted" || this.#seen.has(event.sessionId)) return;

        const text = messageText(event.update.input);
        if (text === undefined) return;

        this.#seen.set(event.sessionId, text);
        void this.#start(event.sessionId, text, false, event.update.inputId);
      }),

      ctx.addListener("session.closed", (event) => {
        this.#running.get(event.sessionId)?.controller.abort();
        this.#seen.delete(event.sessionId);
      }),
    ];
  }

  /** Regenerate the focused session's title from its first user message. */
  async regenerate(id: SessionId): Promise<void> {
    const text = (await firstMessage(this.#sessions, id))?.text ?? this.#seen.get(id);

    if (text === undefined) {
      this.#ctx.notify("info", "Send a message before generating a title.");
      return;
    }

    await this.#start(id, text, true);
  }

  async close(): Promise<void> {
    for (const remove of this.#remove) remove();

    const running = [...this.#running.values()];
    for (const request of running) request.controller.abort();

    await Promise.all(running.map((request) => request.task));
  }

  #start(id: SessionId, text: string, manual: boolean, inputId?: InputId): Promise<void> {
    this.#running.get(id)?.controller.abort();

    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#ctx.signal]);

    const task = this.#rename(id, text, manual, signal, inputId)
      .catch((error: unknown) => {
        if (!signal.aborted) this.#ctx.notify("warn", `The session title did not change: ${String(error)}`);
      })
      .finally(() => {
        if (this.#running.get(id)?.controller === controller) this.#running.delete(id);
      });

    this.#running.set(id, { controller, task });

    return task;
  }

  async #rename(
    id: SessionId,
    text: string,
    manual: boolean,
    signal: AbortSignal,
    inputId: InputId | undefined,
  ): Promise<void> {
    const saved = await this.models.read();

    if (saved.models.length === 0) {
      if (manual) this.#ctx.notify("info", "Choose a title model with titles:settings first.");
      return;
    }

    const row = await this.#sessions.get(id);
    const previous = row.session.title ?? undefined;

    if (!manual) {
      if (row.session.parent !== undefined && row.session.parent !== null) return;
      if (row.session.forkOf !== undefined && row.session.forkOf !== null) return;

      const initial = Array.from(text.replace(/\s+/gu, " ").trim()).slice(0, 200).join("").trimEnd();
      if (previous !== undefined && previous !== initial) return;

      const first = await firstMessage(this.#sessions, id);
      if (first !== undefined && first.id !== inputId) return;
    }

    if (manual) this.#ctx.notify("info", "Generating a session title…");

    const providers = await this.models.providers();
    const failures: string[] = [];

    for (const entry of saved.models) {
      signal.throwIfAborted();

      const resolved = resolveModel(entry, providers);
      if (resolved === undefined) {
        failures.push(`${modelId(entry)}: not available`);
        continue;
      }

      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(new Error("The title request timed out.")), 15_000);
      let title: string;

      try {
        const answer = await generateText({
          model: resolved.model,
          reasoning: resolved.reasoning,
          instructions: `Generate a short, descriptive title (max 6 words) for a chat session based on its first message.

Be concise and specific.
Use simple words and sentence case.

Focus on the main topic or intent.

Use no quotes or punctuation at the end.
Reply with ONLY the title, nothing else.`,
          prompt: text.slice(0, 4000),
          maxOutputTokens: 128,
          signal: AbortSignal.any([signal, attempt.signal]),
        });

        title = answer.text.replace(/\s+/gu, " ").trim();
        if (answer.finishReason !== "stop" || title === "" || Array.from(title).length > 80) {
          failures.push(`${modelId(entry)}: no short, complete title`);
          continue;
        }
      } catch (error) {
        signal.throwIfAborted();
        failures.push(`${modelId(entry)}: ${String(error)}`);
        continue;
      } finally {
        clearTimeout(timer);
      }

      signal.throwIfAborted();

      // A manual rename during the request takes precedence over the generated title.
      const current = await this.#sessions.get(id);
      if ((current.session.title ?? undefined) !== previous) {
        if (manual) this.#ctx.notify("info", "The session title changed while generating. Your title stays.");
        return;
      }

      signal.throwIfAborted();
      await this.#sessions.rename(id, title);

      if (manual) this.#ctx.notify("info", `Session title: ${title}`);
      return;
    }

    signal.throwIfAborted();
    throw new Error(failures.join("\n"));
  }
}
