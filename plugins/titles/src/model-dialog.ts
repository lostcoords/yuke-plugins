import type { ProviderInfo } from "yuke:protocol";
import { type Canvas, strokeOf, type Tui, type View } from "yuke:tui";

import { type ModelEntry, type ModelList, modelId, resolveModel, type SavedModels } from "./models.ts";

const NOTICE = "Changes apply to the next title request.";
const EMPTY = "No title models yet. Press a to add one.";

/** Open the title model settings dialog. */
export async function openModelDialog(tui: Tui, list: ModelList, fail: (text: string) => void): Promise<void> {
  let saved: SavedModels;
  let providers: readonly ProviderInfo[];

  try {
    saved = await list.read();
    providers = await list.providers();
  } catch (error) {
    fail(`the title models did not load: ${String(error)}`);
    return;
  }

  let cursor = 0;
  let changed = false;
  let writes: Promise<void> = Promise.resolve();

  const save = async (next: SavedModels): Promise<void> => {
    saved = next;
    changed = true;
    cursor = Math.min(cursor, Math.max(0, saved.models.length - 1));
    tui.requestFrame();

    writes = writes
      .then(() => list.write(next))
      .catch((error: unknown) => {
        fail(`the title models did not save: ${String(error)}`);
      });
    await writes;
  };

  const add = async (): Promise<void> => {
    try {
      providers = await list.providers();
    } catch (error) {
      fail(`the title models did not load: ${String(error)}`);
      return;
    }

    const models = providers.flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, model })));
    if (models.length === 0) {
      fail("No title models are available. Configure a provider in Yuke first.");
      return;
    }

    const chosen = await tui.select({
      title: "Add a title model",
      items: models,
      label: (entry) => `${entry.provider}/${entry.model.id}`,
    });
    if (chosen === undefined) return;

    const reasoning = await tui.select({
      title: `Reasoning for ${chosen.provider}/${chosen.model.id}`,
      items: chosen.model.reasoning,
      label: (choice) => choice.level,
    });
    if (reasoning === undefined) return;

    const entry: ModelEntry = {
      model: `${chosen.provider}/${chosen.model.id}`,
      reasoning: reasoning.level,
    };
    if (saved.models.some((other) => modelId(other) === modelId(entry))) return;

    await save({ models: [...saved.models, entry] });

    cursor = saved.models.length - 1;
    tui.requestFrame();
  };

  const remove = async (): Promise<void> => {
    const entry = saved.models[cursor];
    if (entry === undefined) return;

    const id = modelId(entry);
    await save({ models: saved.models.filter((other) => modelId(other) !== id) });
  };

  const move = async (direction: -1 | 1): Promise<void> => {
    const target = cursor + direction;
    if (cursor < 0 || target < 0 || target >= saved.models.length) return;

    const models = [...saved.models];
    const selected = models.splice(cursor, 1);
    models.splice(target, 0, ...selected);

    cursor = target;
    await save({ models });
    tui.requestFrame();
  };

  const run = (work: Promise<void>): void => {
    work.catch((error: unknown) => fail(`the title model dialog failed: ${String(error)}`));
  };

  const body: View = {
    focusable: true,
    onKey(event) {
      const stroke = strokeOf(event);
      if (stroke !== "up" && stroke !== "down") return false;

      if (saved.models.length > 0) {
        cursor = Math.max(0, Math.min(saved.models.length - 1, cursor + (stroke === "down" ? 1 : -1)));
        tui.requestFrame();
      }

      return true;
    },

    draw(canvas: Canvas) {
      if (saved.models.length === 0) {
        canvas.text(1, 0, EMPTY, "dialog.keys");
      } else {
        for (const [row, entry] of saved.models.entries()) {
          const role = row === 0 ? "primary" : "fallback";
          const ready = resolveModel(entry, providers) !== undefined;
          const end = [role, ready ? "" : "not ready"].filter(Boolean).join(" · ");

          canvas.text(
            1,
            row,
            `${row === cursor ? ">" : " "} ${modelId(entry)}`,
            row === cursor ? "dialog.title" : undefined,
          );
          canvas.text(Math.max(1, canvas.width - end.length - 1), row, end, "dialog.keys");
        }
      }

      if (changed) canvas.text(1, saved.models.length === 0 ? 1 : saved.models.length, NOTICE, "dialog.keys");
    },
  };

  tui.dialog({
    title: "Title models",
    body,
    keys: [
      { key: "a", label: "add", run: () => run(add()) },
      { key: "d", label: "remove", when: () => saved.models[cursor] !== undefined, run: () => run(remove()) },
      { key: "U", label: "move up", when: () => cursor > 0, run: () => run(move(-1)) },
      {
        key: "D",
        label: "move down",
        when: () => cursor >= 0 && cursor < saved.models.length - 1,
        run: () => run(move(1)),
      },
    ],
  });
}
