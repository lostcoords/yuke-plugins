// The models of subagents: the saved list, the `model` argument, the choice of a model, and the dialog of the list.

import { readTextFile, writeTextFile } from "yuke:fs";
import type { Catalog, PluginApply, PluginContext, PluginSession, ServiceOf, Services, Sessions } from "yuke:plugins";
import type { SessionSettings } from "yuke:protocol";
import { createFrame, createHost, equal, folder, reply, waitForSettled, test } from "yuke:test";
import { apply, session } from "../src/index.ts";
import { openModelDialog } from "../src/model-dialog.ts";
import { ModelList, type SavedModels } from "../src/models.ts";
import { rowsOf } from "./frame-rows.ts";

const OPUS = { thinking: { kind: "adaptive" }, effort: "high" };
const CATALOG = {
  list: async () => ({
    providers: [
      {
        id: "anthropic",
        models: [
          {
            id: "claude-opus",
            reasoning: [
              { level: "high", settings: OPUS },
              { level: "low", settings: {} },
            ],
          },
          { id: "claude-sonnet", reasoning: [{ level: "default", settings: {} }] },
        ],
      },
    ],
  }),
} as unknown as Catalog;
const OPUS_ENTRY = { model: "anthropic/claude-opus", reasoning: "high" };
const GONE_ENTRY = { model: "gone/model", reasoning: "high" };
const SPAWN = { description: "Read the store", message: "Read.", background: false };

/** A host with the plugin, the saved file `file`, and a record of each new session and tool. */
async function opened(file?: string, answers = 0) {
  const dataDir = folder();
  if (file !== undefined) await writeTextFile("settings.json", file, { cwd: dataDir });
  const created: SessionSettings[] = [];
  const tools = new Map<string, { readonly parameters: { readonly properties: Record<string, unknown> } }>();
  const notices: string[] = [];
  let parentSettings: SessionSettings | undefined;
  const pluginApply: PluginApply = (ctx) => {
    const real = ctx.get("sessions");
    const sessions: Sessions = {
      ...real,
      create: (settings, options) => {
        created.push(settings);
        return real.create(parentSettings as SessionSettings, options);
      },
    };
    const get = <K extends keyof Services & string>(name: K): ServiceOf<K> => {
      if (name === "sessions") return sessions as ServiceOf<K>;
      if (name === "catalog") return CATALOG as ServiceOf<K>;
      return ctx.get(name);
    };
    return apply({ ...ctx, dataDir, get } satisfies PluginContext);
  };
  const pluginSession: PluginSession = (s) => {
    parentSettings ??= s.settings;
    return session(
      Object.create(s, {
        notify: { value: (_level: string, text: string) => notices.push(text) },
        tools: {
          value: {
            add: (tool: never) => {
              tools.set((tool as { name: string }).name, tool);
              return s.tools.add(tool);
            },
          },
        },
      }),
    );
  };
  const host = await createHost({
    plugins: [{ name: "subagents", apply: pluginApply, session: pluginSession }],
    replies: Array.from({ length: answers }, () => reply.text("Done.")),
  });
  const parent = await host.openSession();
  return { host, parent, created, tools, notices, session: () => parentSettings as SessionSettings };
}

const file = (saved: SavedModels) => JSON.stringify(saved);
const argument = (state: Awaited<ReturnType<typeof opened>>) =>
  state.tools.get("spawn_subagent")?.parameters.properties.model as { readonly enum?: readonly string[] } | undefined;

test("an empty list gives no model argument, and a subagent uses the session model", async () => {
  const state = await opened(undefined, 1);
  await using _host = state.host;

  await state.parent.call("spawn_subagent", SPAWN);

  equal(argument(state), undefined);
  equal(state.created, [state.session()]);
});

test("the model argument lists the saved models of ready providers", async () => {
  const state = await opened(file({ models: [OPUS_ENTRY, GONE_ENTRY] }));
  await using _host = state.host;

  equal(argument(state)?.enum, ["anthropic/claude-opus:high"]);
});

test("a chosen model sets the model and the reasoning, and it keeps the other settings", async () => {
  const state = await opened(file({ models: [OPUS_ENTRY] }), 1);
  await using _host = state.host;

  await state.parent.call("spawn_subagent", { ...SPAWN, model: "anthropic/claude-opus:high" });

  const parent = state.session();
  equal(state.created, [
    {
      model: { provider: "anthropic", model: "claude-opus" },
      settings: { ...parent.settings, reasoning: OPUS },
      cwd: parent.cwd,
    },
  ]);
});

test("the default of the user applies with no model argument, and the argument wins over it", async () => {
  const state = await opened(
    file({
      default: "anthropic/claude-sonnet:default",
      models: [OPUS_ENTRY, { model: "anthropic/claude-sonnet", reasoning: "default" }],
    }),
    2,
  );
  await using _host = state.host;

  await state.parent.call("spawn_subagent", SPAWN);
  await state.parent.call("spawn_subagent", { ...SPAWN, model: "anthropic/claude-opus:high" });

  equal(
    state.created.map((settings) => settings.model.model),
    ["claude-sonnet", "claude-opus"],
  );
});

test("a default that is gone is an error at the spawn, and no subagent starts", async () => {
  const state = await opened(file({ default: "gone/model:high", models: [GONE_ENTRY] }));
  await using _host = state.host;

  const result = await state.parent.call("spawn_subagent", SPAWN);

  equal(result.isError, true);
  equal(
    result.text,
    "The subagent model gone/model:high is not available. Ask the user to change the list with subagents:models.",
  );
  equal(state.created, []);
});

test("a file that is not JSON names the file in the notice", async () => {
  const state = await opened("{");
  await using _host = state.host;

  await waitForSettled();

  equal(
    state.notices.some((text) => text.includes("settings.json is not JSON")),
    true,
  );
});

test("a broken file gives a notice and no model argument, and a spawn names the file", async () => {
  const state = await opened(`{ "models": 3 }`);
  await using _host = state.host;

  const result = await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();

  equal(argument(state), undefined);
  equal(
    state.notices.some((text) => text.includes("settings.json needs")),
    true,
  );
  equal([result.isError, result.text.includes("settings.json needs")], [true, true]);
});

/** A frame with the dialog on a saved file in a new folder. */
async function dialog(saved?: SavedModels) {
  const frame = createFrame({ width: 70, height: 16 });
  const dataDir = folder();
  if (saved !== undefined) await writeTextFile("settings.json", file(saved), { cwd: dataDir });
  const failures: string[] = [];
  await openModelDialog(frame.surface("subagents").tui, new ModelList(dataDir, CATALOG), (text) => failures.push(text));
  frame.draw();
  const stored = async (): Promise<SavedModels> =>
    JSON.parse(await readTextFile("settings.json", { cwd: dataDir }));
  return { frame, stored, failures };
}

test("the dialog shows the session model as the default, and a saved model that is not ready", async () => {
  const state = await dialog({ models: [OPUS_ENTRY, GONE_ENTRY] });
  using _frame = state.frame;
  const shown = rowsOf(state.frame.frame)
    .map((row) => row.trimEnd().replace(/\s{2,}/g, "  "))
    .filter((row) => row.trim() !== "");

  equal(shown.slice(-5), [
    " Subagent models",
    " > Session model  default",
    "  anthropic/claude-opus:high",
    "  gone/model:high  not ready",
    " a: add · enter: set default · R: reload · esc: close",
  ]);
});

test("a add picks a model and a level, and the list saves it", async () => {
  const state = await dialog();
  using _frame = state.frame;

  state.frame.key("a");
  await waitForSettled();
  state.frame.key("enter");
  await waitForSettled();
  state.frame.key("enter");
  await waitForSettled();

  state.frame.draw();
  equal((await state.stored()).models, [OPUS_ENTRY]);
  equal(rowsOf(state.frame.frame).join("\n").includes("The model list changes in new sessions."), true);
});

test("enter sets the default, the session row clears it, and d removes a model and its default", async () => {
  const state = await dialog({ models: [OPUS_ENTRY] });
  using _frame = state.frame;

  state.frame.key("down");
  state.frame.key("enter");
  await waitForSettled();
  const set = (await state.stored()).default;
  state.frame.key("up");
  state.frame.key("enter");
  await waitForSettled();
  const cleared = (await state.stored()).default;
  state.frame.key("down");
  state.frame.key("enter");
  await waitForSettled();
  state.frame.key("d");
  await waitForSettled();
  const after = await state.stored();

  equal([set, cleared], ["anthropic/claude-opus:high", undefined]);
  equal(after, { models: [] });
});

test("a add of a model that the list holds keeps one row", async () => {
  const state = await dialog({ models: [OPUS_ENTRY] });
  using _frame = state.frame;

  state.frame.key("a");
  await waitForSettled();
  state.frame.key("enter");
  await waitForSettled();
  state.frame.key("enter");
  await waitForSettled();

  equal((await state.stored()).models, [OPUS_ENTRY]);
});

test("two quick keys build on each other, and the file holds both", async () => {
  const second = { model: "anthropic/claude-sonnet", reasoning: "default" };
  const state = await dialog({ models: [OPUS_ENTRY, second] });
  using _frame = state.frame;

  state.frame.key("down");
  state.frame.key("enter");
  state.frame.key("down");
  state.frame.key("d");
  await waitForSettled();

  equal(await state.stored(), { default: "anthropic/claude-opus:high", models: [OPUS_ENTRY] });
});

test("d does nothing on the session row", async () => {
  const state = await dialog({ models: [OPUS_ENTRY] });
  using _frame = state.frame;

  state.frame.key("d");
  await waitForSettled();

  equal((await state.stored()).models, [OPUS_ENTRY]);
});
