// The list of running subagents under the composer: its rows at each width, and its source on a test host.

import type { ChatReadOnly, ChatService, ComposerRow, ComposerRowsContext } from "yuke:chat";
import type { PluginContext, ServiceOf, Services, Sessions } from "yuke:plugins";
import { createFrame, createHost, equal, type Reply, reply, settled, test } from "yuke:test";
import { TextEditor } from "yuke:tui";
import { apply, session as pluginSession } from "../src/index.ts";
import { type ListEntry, listRows } from "../src/list.ts";

const READ: ListEntry = { label: "Read the store", model: "claude-opus-5-5", started: 0 };
const CHECK: ListEntry = { label: "Check the tests", model: "claude-opus-5-5", started: 64_000 };

test("a wide pane shows the description, the model, and the time, in columns", () => {
  equal(listRows([READ, CHECK], 50, 72_000), [
    "Read the store             claude-opus-5-5  1m 12s",
    "Check the tests            claude-opus-5-5      8s",
  ]);
});

test("a narrow pane drops the model of all rows and keeps the time", () => {
  equal(listRows([READ, CHECK], 30, 72_000), ["Read the store          1m 12s", "Check the tests             8s"]);
});

test("a very narrow pane cuts the description before the time", () => {
  equal(listRows([READ], 16, 72_000), ["Read th…  1m 12s"]);
});

test("the list shows four subagents and counts the others", () => {
  const entries = ["a", "b", "c", "d", "e", "f"].map((label) => ({ label, model: "m", started: 0 }));
  const rows = listRows(entries, 20, 0);
  equal([rows.length, rows.at(-1)], [5, "+ 2 more"]);
});

test("the time moves from seconds to minutes to hours", () => {
  const row = (now: number) => listRows([{ label: "a", model: "m", started: 0 }], 12, now)[0];
  equal([row(8000), row(72_000), row(7_500_000)], ["a      m  8s", "a  m  1m 12s", "a  m  2h 05m"]);
});

/** A frame with a composer in a pane, the plugin on a test host, and a fake chat service that shows that pane. */
async function shown(replies: readonly Reply[]) {
  const frame = createFrame({ width: 60, height: 12 });
  const surface = frame.surface("subagents");
  const below: ((pane: ComposerRowsContext) => readonly ComposerRow[])[] = [];
  const above: ((pane: ComposerRowsContext) => readonly ComposerRow[])[] = [];
  const showed: string[] = [];
  let readOnly: ((session: string) => ChatReadOnly | undefined) | undefined;
  let session: string | undefined;
  const chat = {
    addComposerRows: (place: string, rows: (pane: ComposerRowsContext) => readonly ComposerRow[]) => {
      (place === "below" ? below : above).push(rows);
      return () => {};
    },
    setReadOnly: (source: typeof readOnly) => {
      readOnly = source;
      return () => {};
    },
    session: () => session,
    show: async (id: string) => {
      showed.push(id);
    },
  } as unknown as ChatService;
  let sessions: Sessions | undefined;
  const host = await createHost({
    plugins: [
      {
        name: "subagents",
        apply: (ctx) => {
          sessions = ctx.get("sessions");
          const get = <K extends keyof Services & string>(name: K): ServiceOf<K> => {
            if (name === "tui") return surface.tui as ServiceOf<K>;
            if (name === "chat") return chat as ServiceOf<K>;
            return ctx.get(name);
          };
          return apply({ ...ctx, get } satisfies PluginContext);
        },
        session: pluginSession,
      },
    ],
    replies,
  });
  const composer = new TextEditor({ role: "composer" });
  surface.tui.panes.split(() => composer);
  const parent = await host.openSession();
  session = parent.id;
  const held = await (sessions as unknown as Sessions).open(parent.id, { tail: 0, event() {} });
  frame.start();
  const rowsOf = (id: string | undefined) => below[0]?.({ session: id as never, width: 60 }) ?? [];
  const waiting = (id: string | undefined) => above[0]?.({ session: id as never, width: 60 }).map((row) => row.text);
  const children = async () =>
    (await (sessions as unknown as Sessions).list({ parent: parent.id })).sessions.map((row) => row.session.sessionId);
  return {
    frame,
    surface,
    host,
    parent,
    held,
    composer,
    rowsOf,
    waiting,
    showed,
    children,
    readOnly: () => readOnly,
    sessions: () => sessions as unknown as Sessions,
  };
}

const SPAWN = { description: "Read the store", message: "Read.", background: true };
const bold = (rows: readonly ComposerRow[]) =>
  rows.map((row) => (row.style as { readonly bold?: boolean } | undefined)?.bold === true);

test("the list shows a running subagent to the pane of its parent, and the row goes at its end", async () => {
  const state = await shown([reply.stall("Reading")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();
  const [child] = await state.children();

  equal(state.rowsOf(state.parent.id)[0]?.text.replace(/\s+/g, " ").startsWith("Read the store "), true);
  equal([state.rowsOf(child), state.rowsOf(undefined)], [[], []]);

  await state.parent.call("stop", { id: child });
  await settled();
  equal(state.rowsOf(state.parent.id), []);
});

test("the waiting row shows while the parent is idle and a subagent runs", async () => {
  const state = await shown([reply.stall("Reading")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();
  const [child] = await state.children();

  equal(state.waiting(state.parent.id), ["Waiting for 1 subagent"]);
  await state.parent.call("stop", { id: child });
  await settled();
  equal(state.waiting(state.parent.id), []);
});

test("a focus change leaves the selection, so a key in another pane does not stop the subagent", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();

  state.frame.key("down");
  const other = new TextEditor({ role: "composer" });
  state.surface.tui.panes.split(() => other);
  state.frame.draw();
  state.frame.key("x");
  await settled();

  equal(state.rowsOf(state.parent.id).length, 1);
  equal(bold(state.rowsOf(state.parent.id)), [false]);
  equal(other.state.text, "x");
  equal(
    state.surface.tui.status.list().some((item) => item.key.endsWith("subagents")),
    false,
  );
});

test("a subagent stays read-only after its session closes", async () => {
  const state = await shown([reply.text("Done."), reply.text("Thanks.")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();
  const [child] = await state.children();

  await state.sessions().close(child as string);
  await settled();

  equal(state.readOnly()?.(child as string), { text: "Subagent: Read the store", back: state.parent.id });
});

test("the waiting row hides while a turn of the parent runs", async () => {
  const state = await shown([reply.toolCall("spawn_subagent", SPAWN), reply.stall("Parent"), reply.stall("Subagent")]);
  using _frame = state.frame;
  await using _host = state.host;

  void state.parent.send("Read the store.").catch(() => undefined);
  await settled();

  equal(state.rowsOf(state.parent.id).length, 1);
  equal(state.waiting(state.parent.id), []);
});

test("Down with no running subagent stays in the composer", async () => {
  const state = await shown([]);
  using _frame = state.frame;
  await using _host = state.host;

  state.frame.key("down");

  equal(
    state.surface.tui.status.list().some((item) => item.key.endsWith("subagents")),
    false,
  );
});

test("Esc leaves the selection and stops there, so the chat does not cancel the turn", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  let cancels = 0;
  state.surface.tui.commands.add({
    name: "cancel",
    description: "c",
    run: () => {
      cancels += 1;
    },
  });
  state.surface.tui.keys.bind("esc", "cancel");
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();

  state.frame.key("down");
  state.frame.key("esc");
  const during = cancels;
  state.frame.key("esc");

  equal([during, cancels], [0, 1]);
});

test("Down on the last row selects the list, and the keys move, leave, and open", async () => {
  const state = await shown([reply.stall("One"), reply.stall("Two")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await state.parent.call("spawn_subagent", { ...SPAWN, description: "Check the tests" });
  await settled();
  const parent = state.parent.id;
  const hint = () => state.surface.tui.status.list().some((item) => item.key.endsWith("subagents"));

  const before = bold(state.rowsOf(parent));
  state.frame.key("down");
  const first = bold(state.rowsOf(parent));
  const hinted = hint();
  state.frame.key("down");
  const second = bold(state.rowsOf(parent));
  state.frame.key("down");
  const stays = bold(state.rowsOf(parent));
  state.frame.key("up");
  state.frame.key("up");
  const left = bold(state.rowsOf(parent));

  equal(
    [before, first, second, stays, left],
    [
      [false, false],
      [true, false],
      [false, true],
      [false, true],
      [false, false],
    ],
  );
  equal([hinted, hint()], [true, false]);

  state.frame.key("down");
  state.frame.key("enter");
  await settled();
  const [one, two] = await state.children();
  equal(state.showed.length, 1);
  equal([one, two].includes(state.showed[0]), true);
  equal(bold(state.rowsOf(parent)), [false, false]);
});

test("x stops the selected subagent, and the selection leaves with the last row", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();

  state.frame.key("down");
  state.frame.key("x");
  await settled();

  equal(state.rowsOf(state.parent.id), []);
  equal(state.held.jobs(), []);
  equal(
    state.surface.tui.status.list().some((item) => item.key.endsWith("subagents")),
    false,
  );
  equal(state.composer.state.text, "");
});

test("Esc leaves the selection and keeps the draft, and a typed character goes to the draft", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();
  const selectedNow = () => bold(state.rowsOf(state.parent.id))[0];

  state.frame.key("d");
  state.frame.key("down");
  const selected = selectedNow();
  state.frame.key("esc");
  const left = selectedNow();
  state.frame.key("down");
  state.frame.key("r");

  equal([selected, left, selectedNow(), state.composer.state.text], [true, false, false, "dr"]);
});

test("Down moves the caret in a draft of many rows, and no running subagent leaves Down to the composer", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  state.composer.reset({ text: "one\ntwo", spans: [], selection: { anchor: 0, head: 0 } });
  state.frame.draw();

  state.frame.key("down");
  const idle = state.composer.caret;
  state.composer.caret = 0;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();
  state.frame.key("down");
  const inDraft = bold(state.rowsOf(state.parent.id))[0];
  state.frame.key("down");

  equal(idle > 0, true);
  equal(inDraft, false);
  equal(bold(state.rowsOf(state.parent.id))[0], true);
});

test("a subagent is read-only with its label and goes back to its parent, and a parent is not read-only", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await settled();
  const [child] = await state.children();

  equal(state.readOnly()?.(child as string), { text: "Subagent: Read the store", back: state.parent.id });
  equal(state.readOnly()?.(state.parent.id), undefined);
});
