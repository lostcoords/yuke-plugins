import { type Canvas, strokeOf, type Tui, type View } from "yuke:tui";
import { type ModelEntry, type ModelList, modelId, resolveModel, type SavedModels } from "./models.ts";

/** The row of the session model: it is first, and no key removes it. */
const SESSION = "Session model";

const CHANGED = "The model list changes in new sessions.";

/** Open the dialog of the model list. */
export async function openModelDialog(tui: Tui, list: ModelList, fail: (text: string) => void): Promise<void> {
  let saved: SavedModels = await list.read();
  let providers = await list.providers();
  let cursor = 0;
  let changed = false;

  // Each key builds on the newest list, and the writes run in order, so a quick second key loses nothing.
  let writes: Promise<void> = Promise.resolve();

  /** Show `next`, and save it after the writes before it. */
  const save = async (next: SavedModels): Promise<void> => {
    saved = next;
    changed = true;
    cursor = Math.min(cursor, next.models.length);
    tui.requestFrame();
    writes = writes
      .then(() => list.write(next))
      .catch((error: unknown) => {
        fail(`the model list did not save: ${String(error)}`);
      });
    await writes;
  };

  const add = async (): Promise<void> => {
    providers = await list.providers();
    const models = providers.flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, model })));
    const chosen = await tui.select({
      title: "Add a model",
      items: models,
      label: (entry) => `${entry.provider}/${entry.model.id}`,
    });
    if (chosen === undefined) return;
    const level = await tui.select({
      title: `Reasoning for ${chosen.model.id}`,
      items: chosen.model.reasoning,
      label: (choice) => choice.level,
    });
    if (level === undefined) return;
    const entry: ModelEntry = { model: `${chosen.provider}/${chosen.model.id}`, reasoning: level.level };
    if (saved.models.some((other) => modelId(other) === modelId(entry))) return;
    await save({ ...saved, models: [...saved.models, entry] });
    cursor = saved.models.length;
  };

  const remove = async (): Promise<void> => {
    const entry = saved.models[cursor - 1];
    if (entry === undefined) return;
    const id = modelId(entry);
    const models = saved.models.filter((other) => modelId(other) !== id);
    await save(saved.default === id ? { models } : { ...saved, models });
  };

  const setDefault = async (): Promise<void> => {
    const entry = saved.models[cursor - 1];
    await save(entry === undefined ? { models: saved.models } : { ...saved, default: modelId(entry) });
  };

  const run = (work: Promise<void>): void => {
    work.catch((error: unknown) => fail(`the model list failed: ${String(error)}`));
  };

  const body: View = {
    focusable: true,
    key(event) {
      const stroke = strokeOf(event);
      const down = stroke === "down";
      if (!down && stroke !== "up") return false;
      cursor = Math.max(0, Math.min(saved.models.length, cursor + (down ? 1 : -1)));
      tui.requestFrame();
      return true;
    },
    draw(canvas: Canvas) {
      const rows = [
        { text: SESSION, end: saved.default === undefined ? "default" : "" },
        ...saved.models.map((entry) => {
          const id = modelId(entry);
          const ready = resolveModel(entry, providers) !== undefined;
          return {
            text: id,
            end: [saved.default === id ? "default" : "", ready ? "" : "not ready"].filter(Boolean).join(" · "),
          };
        }),
      ];
      for (const [row, entry] of rows.entries()) {
        canvas.text(1, row, `${row === cursor ? ">" : " "} ${entry.text}`, row === cursor ? "dialog.title" : undefined);
        if (entry.end !== "")
          canvas.text(Math.max(1, canvas.width - entry.end.length - 1), row, entry.end, "dialog.keys");
      }
      if (changed) canvas.text(1, rows.length, CHANGED, "dialog.keys");
    },
  };

  tui.dialog({
    title: () => "Subagent models",
    body,
    keys: [
      { key: "a", label: "add", run: () => run(add()) },
      { key: "d", label: "remove", when: () => cursor > 0, run: () => run(remove()) },
      { key: "enter", label: "set default", run: () => run(setDefault()) },
      { key: "R", label: "reload", run: () => tui.commands.run("core:reload") },
    ],
  });
}
