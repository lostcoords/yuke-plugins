import { readTextFile, writeTextFile } from "yuke:fs";
import type { Catalog } from "yuke:plugins";
import { assert, assertEquals, createFrame, createHost, folder, test, waitForSettled } from "yuke:test";
import { openModelDialog } from "../src/model-dialog.ts";
import { ModelList, type SavedModels } from "../src/models.ts";

const FABLE = { model: "anthropic/claude-fable-5", reasoning: "default" } as const;
const FABLE_NEXT = { model: "anthropic/claude-fable-5-1", reasoning: "default" } as const;
const GONE = { model: "gone/model", reasoning: "high" } as const;

/** The settings dialog of the real plugin, in a frame, with `saved` as its settings file. */
async function openDialog(saved?: unknown) {
  const frame = createFrame({ width: 100, height: 24 });
  const tui = frame.surface("test").tui;
  const dataDir = folder();
  if (saved !== undefined) await writeTextFile("settings.json", JSON.stringify(saved), { folder: dataDir });
  const host = await createHost({
    frame,
    plugins: [{ bundled: "chat" }, { folder: `${import.meta.dirname}/..`, dataDir }],
  });
  frame.start();
  assertEquals(tui.commands.run("titles:settings"), true);
  await waitForSettled();
  return {
    frame,
    host,
    stored: async (): Promise<SavedModels> => JSON.parse(await readTextFile("settings.json", { folder: dataDir })),
    async [Symbol.asyncDispose]() {
      await host.close();
      frame[Symbol.dispose]();
    },
  };
}

test("the dialog marks an unavailable model, and a move action reorders primary and fallback models", async () => {
  await using state = await openDialog({ models: [FABLE, GONE, FABLE_NEXT] });
  const { frame } = state;
  assertEquals(
    frame
      .rows()
      .filter((row) => row.includes("claude-fable-5") || row.includes("gone/model"))
      .map((row) => row.trim().replace(/\s+/gu, " ")),
    [
      "> anthropic/claude-fable-5:default primary",
      "gone/model:high fallback · not ready",
      "anthropic/claude-fable-5-1:default fallback",
    ],
  );

  // Arrow keys select only. A move action writes the new order.
  frame.key("down");
  frame.key("up");
  frame.key("down");
  await waitForSettled();
  assertEquals((await state.stored()).models, [FABLE, GONE, FABLE_NEXT]);
  frame.key("U");
  await waitForSettled();
  assertEquals((await state.stored()).models, [GONE, FABLE, FABLE_NEXT]);
});

test("a duplicate add leaves one row, and remove can empty the list", async () => {
  await using state = await openDialog({ models: [FABLE] });
  const { frame } = state;

  frame.key("a");
  await waitForSettled();
  frame.key("enter");
  await waitForSettled();
  frame.key("enter");
  await waitForSettled();
  assertEquals((await state.stored()).models, [FABLE]);

  frame.key("d");
  await waitForSettled();
  assertEquals(await state.stored(), { models: [] });
  assert(frame.rows().some((row) => row.includes("No title models yet")));
});

test("a settings file that is not valid is reported at load", async () => {
  await using state = await openDialog({ models: [{ model: "", reasoning: "default" }] });

  assertEquals(
    state.host.notices.some((notice) => notice.level === "error" && notice.text.includes("settings.json needs")),
    true,
  );
});

test("adding a model without a ready provider explains how to finish setup", async () => {
  using frame = createFrame({ width: 76, height: 12 });
  const catalog = { list: async () => ({ providers: [] }) } as unknown as Catalog;
  const failures: string[] = [];
  await openModelDialog(frame.surface("titles").tui, new ModelList(folder(), catalog), (text) => failures.push(text));
  frame.key("a");
  await waitForSettled();

  assertEquals(failures, ["No title models are available. Configure a provider in Yuke first."]);
  assert(frame.rows().some((row) => row.includes("No title models yet")));
});
