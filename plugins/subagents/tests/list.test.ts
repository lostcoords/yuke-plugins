// The list of running subagents under the composer of the real chat: its rows at each width, and its keys.

import type { ChatService } from "yuke:chat";
import type { Sessions } from "yuke:plugins";
import type { SessionSettings } from "yuke:protocol";
import {
  assert,
  assertEquals,
  createFrame,
  createHost,
  type FrameTest,
  type Reply,
  reply,
  test,
  waitForSettled,
} from "yuke:test";
import { type ListEntry, listRows } from "../src/list.ts";

const READ: ListEntry = { label: "Read the store", model: "claude-opus-5-5", started: 0 };
const CHECK: ListEntry = { label: "Check the tests", model: "claude-opus-5-5", started: 64_000 };

test("a wide list shows the description, the model, and the time, in columns", () => {
  assertEquals(listRows([READ, CHECK], 50, 72_000), [
    "Read the store             claude-opus-5-5  1m 12s",
    "Check the tests            claude-opus-5-5      8s",
  ]);
});

test("a narrow list drops the model of all rows and keeps the time", () => {
  assertEquals(listRows([READ, CHECK], 30, 72_000), [
    "Read the store          1m 12s",
    "Check the tests             8s",
  ]);
});

test("a very narrow list cuts the description before the time", () => {
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

const SPAWN = { description: "Read the store", message: "Read.", background: true };
const HINT_ID = "subagents:subagents";

/** The plugin on the real chat of a frame, which shows a new parent session. */
async function shown(replies: readonly Reply[], height = 12) {
  const probed: { chat?: ChatService; sessions?: Sessions; settings?: SessionSettings } = {};
  const frame = createFrame({ width: 60, height }, undefined, { folder: "/w" });
  const host = await createHost({
    frame,
    plugins: [
      { bundled: "chat" },
      { folder: `${import.meta.dirname}/..` },
      {
        name: "probe",
        uses: ["chat"],
        apply: (ctx) => {
          probed.chat = ctx.get("chat");
          probed.sessions = ctx.get("sessions");
          return undefined;
        },
      },
    ],
    replies,
  });
  const chat = probed.chat as ChatService;
  const sessions = probed.sessions as Sessions;
  const parent = await host.openSession();
  frame.start();
  await chat.show(parent.id);
  return {
    frame,
    host,
    parent,
    chat,
    sessions,
    /** The subagents of the parent, the oldest first. */
    children: async () => (await sessions.list({ parent: parent.id })).sessions.map((row) => row.sessionId).reverse(),
  };
}

/** Run the tool `spawn_subagent` of `parent` for each description, and wait until the subagents run. */
async function spawn(state: Awaited<ReturnType<typeof shown>>, ...descriptions: string[]): Promise<void> {
  for (const description of descriptions) await state.parent.call("spawn_subagent", { ...SPAWN, description });
  await waitForSettled();
}

/** The rows of the frame, with runs of spaces shortened to one. */
function squeezed(frame: FrameTest): string[] {
  return frame.rows().map((row) => row.replace(/ +/g, " "));
}

/** The text of each row with a bold cell. */
function boldRows(frame: FrameTest): string[] {
  return squeezed(frame).filter((_, at) => frame.frame.cells[at]?.some((cell) => cell.style.bold === true));
}

/** Whether a plugin item of the status bar shows the key hint of the list. */
function hinted(frame: FrameTest): boolean {
  return frame
    .surface("test")
    .tui.status.list()
    .some((item) => item.id === HINT_ID);
}

test("the list shows a running subagent below the composer of its parent, also while the subagent shows", async () => {
  const state = await shown([reply.stall("Reading")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");
  const [child] = await state.children();

  assertEquals(squeezed(state.frame).at(-1), "Read the store MiniMax-M3 0s");
  await state.chat.show(child as string);
  assertEquals(squeezed(state.frame).at(-1), "Read the store MiniMax-M3 0s");

  await state.chat.show(state.parent.id);
  await state.parent.call("stop", { id: child });
  await waitForSettled();
  assertEquals(
    squeezed(state.frame).some((row) => row.startsWith("Read the store")),
    false,
  );
});

test("the waiting row shows while the parent is idle and a subagent runs", async () => {
  const state = await shown([reply.stall("Reading")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");
  const [child] = await state.children();

  assert(state.frame.rows().includes("Waiting for 1 subagent"));
  await state.parent.call("stop", { id: child });
  await waitForSettled();
  assertEquals(state.frame.rows().includes("Waiting for 1 subagent"), false);
});

test("the waiting row hides while the chat shows an ended subagent", async () => {
  const state = await shown([reply.text("Done."), reply.text("Thanks."), reply.stall("Reading")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");
  await spawn(state, "Check the tests");
  const [ended] = await state.children();

  const before = state.frame.rows().includes("Waiting for 1 subagent");
  await state.chat.show(ended as string);

  assertEquals([before, state.frame.rows().includes("Waiting for 1 subagent")], [true, false]);
});

test("the waiting row hides while a turn of the parent runs", async () => {
  const state = await shown([
    reply.toolCalls([{ name: "spawn_subagent", args: SPAWN }]),
    reply.stall("Parent"),
    reply.stall("Subagent"),
  ]);
  using _frame = state.frame;
  await using _host = state.host;

  void state.parent.sendMessage("Read the store.").catch(() => undefined);
  await waitForSettled();

  const rows = squeezed(state.frame);
  assertEquals(rows.at(-1), "Read the store MiniMax-M3 0s");
  assertEquals(
    rows.some((row) => row.startsWith("Waiting for")),
    false,
  );
  assert(rows.some((row) => row.includes("esc to interrupt")));
});

test("a short place scrolls to the selected row, so a key never acts on a hidden row", async () => {
  const state = await shown([reply.stall("One"), reply.stall("Two"), reply.stall("Three")], 4);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store", "Check the tests", "Read the rest");

  state.frame.key("down");
  state.frame.key("down");
  state.frame.key("down");

  assertEquals(boldRows(state.frame), ["Read the rest MiniMax-M3 0s"]);
});

test("a switch to another root asks, and its stop closes the parent and the subagent and leaves the selection", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");
  const [child] = await state.children();
  const other = await state.host.openSession();

  state.frame.key("down");
  const showing = state.chat.show(other.id);
  await waitForSettled();
  const asked = squeezed(state.frame).join("\n");
  state.frame.key("enter");
  await showing;
  await waitForSettled();

  assert(asked.includes("1 job is running."), asked);
  assertEquals(
    [(await state.sessions.get(state.parent.id)).state, (await state.sessions.get(child as string)).state],
    ["closed", "closed"],
  );
  assertEquals([state.chat.sessionId(), boldRows(state.frame), hinted(state.frame)], [other.id, [], false]);
});

test("Down with no running subagent stays in the composer", async () => {
  const state = await shown([]);
  using _frame = state.frame;
  await using _host = state.host;

  state.frame.key("down");

  assertEquals(hinted(state.frame), false);
  assertEquals(boldRows(state.frame), []);
});

test("Down on the last row selects the list, and the keys move, leave, and open", async () => {
  const state = await shown([reply.stall("One"), reply.stall("Two")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store", "Check the tests");

  const before = boldRows(state.frame);
  state.frame.key("down");
  const first = boldRows(state.frame);
  const withHint = hinted(state.frame);
  state.frame.key("down");
  const second = boldRows(state.frame);
  state.frame.key("down");
  const stays = boldRows(state.frame);
  state.frame.key("up");
  state.frame.key("up");
  const left = boldRows(state.frame);

  assertEquals(
    [before, first, second, stays, left],
    [[], ["Read the store MiniMax-M3 0s"], ["Check the tests MiniMax-M3 0s"], ["Check the tests MiniMax-M3 0s"], []],
  );
  assertEquals([withHint, hinted(state.frame)], [true, false]);

  state.frame.key("down");
  state.frame.key("down");
  state.frame.key("enter");
  await waitForSettled();

  assert(state.frame.rows().includes("Subagent: Check the tests · esc back"));
  assertEquals(hinted(state.frame), false);
});

test("x stops the selected subagent, and the selection leaves with the last row", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");

  state.frame.key("down");
  state.frame.key("x");
  await waitForSettled();

  const rows = squeezed(state.frame);
  assertEquals(
    rows.some((row) => row.startsWith("Read the store")),
    false,
  );
  assertEquals(rows.at(-2), "Message…");
  assertEquals(hinted(state.frame), false);
});

test("Esc leaves the selection and stops there, so the chat does not cancel the turn", async () => {
  const state = await shown([
    reply.toolCalls([{ name: "spawn_subagent", args: SPAWN }]),
    reply.stall("Parent"),
    reply.stall("Subagent"),
  ]);
  using _frame = state.frame;
  await using _host = state.host;
  void state.parent.sendMessage("Read the store.").catch(() => undefined);
  await waitForSettled();
  const working = () => state.frame.rows().some((row) => row.includes("esc to interrupt"));
  // The header of the tool call in the transcript is bold too.
  const before = boldRows(state.frame);

  state.frame.key("down");
  const selected = boldRows(state.frame);
  state.frame.key("esc");
  await waitForSettled();
  const afterFirst = [working(), boldRows(state.frame)];
  state.frame.key("esc");
  await waitForSettled();

  assertEquals(selected, [...before, "Read the store MiniMax-M3 0s"]);
  assertEquals(afterFirst, [true, before]);
  assertEquals(working(), false);
});

test("Esc leaves the selection and keeps the draft, and a typed character goes to the draft", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");

  state.frame.key("d");
  state.frame.key("down");
  const selected = boldRows(state.frame);
  state.frame.key("esc");
  const left = boldRows(state.frame);
  state.frame.key("down");
  state.frame.key("r");

  assertEquals([selected, left, boldRows(state.frame)], [["Read the store MiniMax-M3 0s"], [], []]);
  assertEquals(squeezed(state.frame).at(-3), "dr");
});

test("Down moves the caret in a draft of many rows, and selects the list only from its last row", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");
  state.frame.paste("one\ntwo");
  state.frame.key("up");
  const top = state.frame.frame.cursor?.row as number;

  state.frame.key("down");
  const inDraft = [boldRows(state.frame), (state.frame.frame.cursor?.row as number) - top];
  state.frame.key("down");

  assertEquals(inDraft, [[], 1]);
  assertEquals(boldRows(state.frame), ["Read the store MiniMax-M3 0s"]);
});

test("a subagent shows its label and goes back to its parent, and the parent is not read-only", async () => {
  const state = await shown([reply.stall("One")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");
  const [child] = await state.children();
  const parentRows = squeezed(state.frame);

  await state.chat.show(child as string);
  const childRows = state.frame.rows();
  state.frame.key("esc");
  await waitForSettled();

  assertEquals(parentRows.at(-3), "Message…");
  assert(childRows.includes("Subagent: Read the store · esc back"));
  assertEquals(squeezed(state.frame).at(-3), "Message…");
});

test("a subagent stays read-only after the end of its run closes its session", async () => {
  const state = await shown([reply.text("Done."), reply.text("Thanks.")]);
  using _frame = state.frame;
  await using _host = state.host;
  await spawn(state, "Read the store");
  const [child] = await state.children();
  const closed = (await state.sessions.get(child as string)).state;

  await state.chat.show(child as string);

  assertEquals(closed, "closed");
  assert(state.frame.rows().includes("Subagent: Read the store · esc back"));
});
