import { readTextFile, writeTextFile } from "yuke:fs";
import type { Catalog } from "yuke:plugins";
import type { ProviderInfo } from "yuke:protocol";
import { assertEquals, assertRejects, createFrame, folder, test, waitForSettled } from "yuke:test";
import { openModelDialog } from "../src/model-dialog.ts";
import { ModelList, modelId, resolveModel, type SavedModels } from "../src/models.ts";

const REASONING = { thinking: { kind: "adaptive" }, effort: "high" } as const;
const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    state: { kind: "ready" },
    models: [
      {
        id: "claude-opus",
        reasoning: [
          { level: "high", settings: REASONING },
          { level: "low", settings: {} },
        ],
      },
      { id: "claude-sonnet", reasoning: [{ level: "default", settings: {} }] },
    ],
  },
] as unknown as readonly ProviderInfo[];
const CATALOG = { list: async () => ({ providers: PROVIDERS }) } as unknown as Catalog;
const OPUS = { model: "anthropic/claude-opus", reasoning: "high" } as const;
const SONNET = { model: "anthropic/claude-sonnet", reasoning: "default" } as const;

function rows(frame: ReturnType<typeof createFrame>): string[] {
  return frame.frame.cells.map((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .trimEnd(),
  );
}

async function dialog(saved?: SavedModels) {
  const frame = createFrame({ width: 76, height: 12 });
  const dataDir = folder();
  if (saved !== undefined) await writeTextFile("settings.json", JSON.stringify(saved), { cwd: dataDir });
  const failures: string[] = [];
  await openModelDialog(frame.surface("titles").tui, new ModelList(dataDir, CATALOG), (text) => failures.push(text));
  frame.draw();
  return {
    frame,
    failures,
    stored: async (): Promise<SavedModels> => JSON.parse(await readTextFile("settings.json", { cwd: dataDir })),
  };
}

test("a missing or empty settings file reads as an empty model list, and saved models round trip", async () => {
  const dataDir = folder();
  const list = new ModelList(dataDir, CATALOG);

  assertEquals(await list.read(), { models: [] });
  await writeTextFile("settings.json", "  \n", { cwd: dataDir });
  assertEquals(await list.read(), { models: [] });
  await writeTextFile("settings.json", "{}", { cwd: dataDir });
  assertEquals(await list.read(), { models: [] });
  await list.write({ models: [OPUS, SONNET] });
  assertEquals(await list.read(), { models: [OPUS, SONNET] });
  assertEquals(JSON.parse(await readTextFile("settings.json", { cwd: dataDir })), { models: [OPUS, SONNET] });
});

test("saved entries need nonempty model and reasoning strings", async () => {
  const dataDir = folder();
  const list = new ModelList(dataDir, CATALOG);
  await writeTextFile("settings.json", JSON.stringify({ models: [{ model: "", reasoning: "high" }] }), {
    cwd: dataDir,
  });

  const error = await assertRejects(() => list.read());
  assertEquals(String(error).includes("settings.json needs"), true);
});

test("model ids and provider resolution use the selected reasoning settings", () => {
  assertEquals(modelId(OPUS), "anthropic/claude-opus:high");
  assertEquals(resolveModel(OPUS, PROVIDERS), {
    model: { provider: "anthropic", model: "claude-opus" },
    reasoning: { thinking: { kind: "adaptive" }, effort: "high" },
  });
  assertEquals(resolveModel({ model: "gone/model", reasoning: "high" }, PROVIDERS), undefined);
});

test("an empty dialog explains setup and an add saves the selected model and reasoning", async () => {
  const state = await dialog();
  using frame = state.frame;

  assertEquals(
    rows(frame).some((row) => row.includes("No title models yet. Press a to add one.")),
    true,
  );
  frame.key("a");
  await waitForSettled();
  frame.key("enter");
  await waitForSettled();
  frame.key("enter");
  await waitForSettled();

  assertEquals(await state.stored(), { models: [OPUS] });
  assertEquals(state.failures, []);
});

test("arrow keys select without reordering, and explicit move actions reorder primary and fallback models", async () => {
  const state = await dialog({ models: [OPUS, SONNET] });
  using frame = state.frame;

  frame.key("down");
  frame.key("up");
  assertEquals((await state.stored()).models, [OPUS, SONNET]);
  frame.key("down");
  frame.key("U");
  await waitForSettled();
  assertEquals((await state.stored()).models, [SONNET, OPUS]);
  assertEquals(
    rows(frame).some((row) => row.includes("primary")),
    true,
  );
});

test("a duplicate add leaves one row, and remove can empty the list", async () => {
  const state = await dialog({ models: [OPUS] });
  using frame = state.frame;

  frame.key("a");
  await waitForSettled();
  frame.key("enter");
  await waitForSettled();
  frame.key("enter");
  await waitForSettled();
  assertEquals((await state.stored()).models, [OPUS]);

  frame.key("d");
  await waitForSettled();
  assertEquals(await state.stored(), { models: [] });
  assertEquals(
    rows(frame).some((row) => row.includes("No title models yet")),
    true,
  );
});

test("adding a model without a ready provider explains how to finish setup", async () => {
  using frame = createFrame({ width: 76, height: 12 });
  const empty = { list: async () => ({ providers: [] }) } as unknown as Catalog;
  const failures: string[] = [];
  await openModelDialog(frame.surface("titles").tui, new ModelList(folder(), empty), (text) => failures.push(text));
  frame.key("a");
  await waitForSettled();

  assertEquals(failures, ["No title models are available. Configure a provider in Yuke first."]);
  assertEquals(
    rows(frame).some((row) => row.includes("No title models yet")),
    true,
  );
});
