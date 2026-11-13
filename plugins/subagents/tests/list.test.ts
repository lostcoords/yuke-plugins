// The list of running subagents under the composer: its rows at each width, and its source on a test host.

import type { ChatPane, ChatReadOnly, ChatService, ComposerView } from "yuke:chat";
import type { PluginContext, ServiceOf, Services, Sessions } from "yuke:plugins";
import { assertEquals, createFrame, createHost, type Reply, reply, test, waitForSettled } from "yuke:test";
import { type Canvas, type Mount, TextEditor } from "yuke:tui";
import { apply, session as pluginSession } from "../src/index.ts";
import { type ListEntry, listRows } from "../src/list.ts";

const READ: ListEntry = { label: "Read the store", model: "claude-opus-5-5", started: 0 };
const CHECK: ListEntry = { label: "Check the tests", model: "claude-opus-5-5", started: 64_000 };

test("a wide pane shows the description, the model, and the time, in columns", () => {
  assertEquals(listRows([READ, CHECK], 50, 72_000), [
    "Read the store             claude-opus-5-5  1m 12s",
    "Check the tests            claude-opus-5-5      8s",
  ]);
});

test("a narrow pane drops the model of all rows and keeps the time", () => {
  assertEquals(listRows([READ, CHECK], 30, 72_000), [
    "Read the store          1m 12s",
    "Check the tests             8s",
  ]);
});

test("a very narrow pane cuts the description before the time", () => {
  assertEquals(listRows([READ], 16, 72_000), ["Read th…  1m 12s"]);
});

test("the list shows four subagents and counts the others", () => {
  const entries = ["a", "b", "c", "d", "e", "f"].map((label) => ({ label, model: "m", started: 0 }));
  const rows = listRows(entries, 20, 0);
  assertEquals([rows.length, rows.at(-1)], [5, "+ 2 more"]);
});

test("the time moves from seconds to minutes to hours", () => {
  const row = (now: number) => listRows([{ label: "a", model: "m", started: 0 }], 12, now)[0];
  assertEquals([row(8000), row(72_000), row(7_500_000)], ["a      m  8s", "a  m  1m 12s", "a  m  2h 05m"]);
});

/** A frame with a composer in a pane, the plugin on a test host, and a fake chat service that shows that pane. */
interface Row {
  readonly text: string;
  readonly style: unknown;
}

async function shown(replies: readonly Reply[]) {
  const frame = createFrame({ width: 60, height: 12 });
  const surface = frame.surface("subagents");
  type Create = (mount: Mount, pane: ChatPane) => ComposerView;
  const below: Create[] = [];
  const above: Create[] = [];
  const showed: string[] = [];
  let readOnly: ((session: string) => ChatReadOnly | undefined) | undefined;
  let session: string | undefined;
  const watchers: ((pane: ChatPane, signal: AbortSignal) => void)[] = [];
  const chat = {
    addPaneWatcher: (watch: (pane: ChatPane, signal: AbortSignal) => void) => {
      watchers.push(watch);
      return () => {};
    },
    addComposerView: (place: string, create: Create) => {
      (place === "below" ? below : above).push(create);
      return () => {};
    },
    addReadOnly: (source: typeof readOnly) => {
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
  // The pane of the composer, as the chat gives it to a watcher: its session is the one that it shows now.
  const pane = {
    view: composer,
    composer,
    get session() {
      return session as never;
    },
    running: false,
    transcript: {} as never,
  };
  for (const watch of watchers) watch(pane, new AbortController().signal);
  const parent = await host.openSession();
  session = parent.id;
  const held = await (sessions as unknown as Sessions).open(parent.id, { tail: 0, onEvent() {} });
  frame.start();
  /** The rows that the view of `create` draws for a pane on the session `id`, with `height` rows or all it wants. */
  const drawn = (create: Create | undefined, id: string | undefined, height?: number) => {
    const rows: Row[] = [];
    const mount = { signal: new AbortController().signal, close() {} };
    const view = create?.(mount, {
      session: id as never,
      view: composer,
      composer,
      running: false,
      transcript: {} as never,
    });
    const canvas = {
      width: 60,
      height: height ?? view?.heightFor(60) ?? 0,
      text: (_column: number, row: number, text: string, style?: unknown) => {
        rows[row] = { text, style };
        return 0;
      },
    } as unknown as Canvas;
    view?.draw(canvas, false);
    return rows;
  };
  const rowsOf = (id: string | undefined, height?: number) => drawn(below[0], id, height);
  const waiting = (id: string | undefined) => drawn(above[0], id).map((row) => row.text);
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
    show: (id: string) => {
      session = id;
    },
    sessions: () => sessions as unknown as Sessions,
  };
}

const SPAWN = { description: "Read the store", message: "Read.", background: true };
const bold = (rows: readonly Row[]) =>
  rows.map((row) => (row.style as { readonly bold?: boolean } | undefined)?.bold === true);

test("the list shows a running subagent to the pane of its parent, and the row goes at its end", async () => {
  const state = await shown([reply.stall("Reading")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();
  const [child] = await state.children();

  assertEquals(state.rowsOf(state.parent.id)[0]?.text.replace(/\s+/g, " ").startsWith("Read the store "), true);
  assertEquals([state.rowsOf(child), state.rowsOf(undefined)], [[], []]);

  await state.parent.call("stop", { id: child });
  await waitForSettled();
  assertEquals(state.rowsOf(state.parent.id), []);
});

test("the waiting row shows while the parent is idle and a subagent runs", async () => {
  const state = await shown([reply.stall("Reading")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();
  const [child] = await state.children();

  assertEquals(state.waiting(state.parent.id), ["Waiting for 1 subagent"]);
  await state.parent.call("stop", { id: child });
  await waitForSettled();
  assertEquals(state.waiting(state.parent.id), []);
});

test("a short place scrolls to the selected row, so a key never acts on a hidden row", async () => {
  const state = await shown([reply.stall("One"), reply.stall("Two")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await state.parent.call("spawn_subagent", { ...SPAWN, description: "Read the rest" });
  await waitForSettled();

  state.frame.key("down");
  state.frame.key("down");

  const place = state.rowsOf(state.parent.id, 1);
  assertEquals([place.length, bold(place), place[0]?.text.startsWith("Read the rest")], [1, [true], true]);
});

test("a pane that shows another session leaves the selection, so x does not stop a subagent of the old session", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();

  state.frame.key("down");
  state.show("other");
  state.frame.key("x");
  await waitForSettled();

  assertEquals([state.rowsOf(state.parent.id).length, state.composer.state.text], [1, "x"]);
});

test("a focus change leaves the selection, so a key in another pane does not stop the subagent", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();

  state.frame.key("down");
  const other = new TextEditor({ role: "composer" });
  state.surface.tui.panes.split(() => other);
  state.frame.draw();
  state.frame.key("x");
  await waitForSettled();

  assertEquals(state.rowsOf(state.parent.id).length, 1);
  assertEquals(bold(state.rowsOf(state.parent.id)), [false]);
  assertEquals(other.state.text, "x");
  assertEquals(
    state.surface.tui.status.list().some((item) => item.id.endsWith("subagents")),
    false,
  );
});

test("a subagent stays read-only after its session closes", async () => {
  const state = await shown([reply.text("Done."), reply.text("Thanks.")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();
  const [child] = await state.children();

  await state.sessions().closeForAll(child as string);
  await waitForSettled();

  assertEquals(state.readOnly()?.(child as string), { text: "Subagent: Read the store", back: state.parent.id });
});

test("the waiting row hides while a turn of the parent runs", async () => {
  const state = await shown([reply.toolCall("spawn_subagent", SPAWN), reply.stall("Parent"), reply.stall("Subagent")]);
  using _frame = state.frame;
  await using _host = state.host;

  void state.parent.sendMessage("Read the store.").catch(() => undefined);
  await waitForSettled();

  assertEquals(state.rowsOf(state.parent.id).length, 1);
  assertEquals(state.waiting(state.parent.id), []);
});

test("Down with no running subagent stays in the composer", async () => {
  const state = await shown([]);
  using _frame = state.frame;
  await using _host = state.host;

  state.frame.key("down");

  assertEquals(
    state.surface.tui.status.list().some((item) => item.id.endsWith("subagents")),
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
  state.surface.tui.keys.add("esc", "cancel");
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();

  state.frame.key("down");
  state.frame.key("esc");
  const during = cancels;
  state.frame.key("esc");

  assertEquals([during, cancels], [0, 1]);
});

test("Down on the last row selects the list, and the keys move, leave, and open", async () => {
  const state = await shown([reply.stall("One"), reply.stall("Two")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await state.parent.call("spawn_subagent", { ...SPAWN, description: "Check the tests" });
  await waitForSettled();
  const parent = state.parent.id;
  const hint = () => state.surface.tui.status.list().some((item) => item.id.endsWith("subagents"));

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

  assertEquals(
    [before, first, second, stays, left],
    [
      [false, false],
      [true, false],
      [false, true],
      [false, true],
      [false, false],
    ],
  );
  assertEquals([hinted, hint()], [true, false]);

  state.frame.key("down");
  state.frame.key("enter");
  await waitForSettled();
  const [one, two] = await state.children();
  assertEquals(state.showed.length, 1);
  assertEquals([one, two].includes(state.showed[0]), true);
  assertEquals(bold(state.rowsOf(parent)), [false, false]);
});

test("x stops the selected subagent, and the selection leaves with the last row", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();

  state.frame.key("down");
  state.frame.key("x");
  await waitForSettled();

  assertEquals(state.rowsOf(state.parent.id), []);
  assertEquals(state.held.jobs(), []);
  assertEquals(
    state.surface.tui.status.list().some((item) => item.id.endsWith("subagents")),
    false,
  );
  assertEquals(state.composer.state.text, "");
});

test("Esc leaves the selection and keeps the draft, and a typed character goes to the draft", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();
  const selectedNow = () => bold(state.rowsOf(state.parent.id))[0];

  state.frame.key("d");
  state.frame.key("down");
  const selected = selectedNow();
  state.frame.key("esc");
  const left = selectedNow();
  state.frame.key("down");
  state.frame.key("r");

  assertEquals([selected, left, selectedNow(), state.composer.state.text], [true, false, false, "dr"]);
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
  await waitForSettled();
  state.frame.key("down");
  const inDraft = bold(state.rowsOf(state.parent.id))[0];
  state.frame.key("down");

  assertEquals(idle > 0, true);
  assertEquals(inDraft, false);
  assertEquals(bold(state.rowsOf(state.parent.id))[0], true);
});

test("a subagent is read-only with its label and goes back to its parent, and a parent is not read-only", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await state.parent.call("spawn_subagent", SPAWN);
  await waitForSettled();
  const [child] = await state.children();

  assertEquals(state.readOnly()?.(child as string), { text: "Subagent: Read the store", back: state.parent.id });
  assertEquals(state.readOnly()?.(state.parent.id), undefined);
});
