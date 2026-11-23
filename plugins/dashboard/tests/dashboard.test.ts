import type { ChatPane } from "yuke:chat";
import type { PluginContext, ServiceOf, Services } from "yuke:plugins";
import { assert, assertEquals, createFrame, createHost, type FrameTest, test } from "yuke:test";
import { type Mount, TextEditor, type Tui, type View } from "yuke:tui";
import { apply } from "../src/index.ts";

type EmptyView = (mount: Mount, pane: ChatPane) => View;

/** Give the plugin the terminal of a frame surface in place of the headless one of the test host. */
function withTerminal(ctx: PluginContext, tui: Tui): PluginContext {
  const get = <K extends keyof Services & string>(name: K): ServiceOf<K> =>
    name === "tui" ? (tui as ServiceOf<K>) : ctx.get(name);
  return { ...ctx, get };
}

/** Draw the frame, and give its text with one row per line. */
function screen(frame: FrameTest): string {
  frame.draw();
  return frame.frame.cells.map((row) => row.map((cell) => cell.text).join("")).join("\n");
}

/**
 * A frame with the dashboard over an empty chat pane, and the plugin `usage` that adds `u` to the menu. Each run of a
 * command adds its name to `ran`.
 */
async function dashboard() {
  const frame = createFrame({ width: 100, height: 60 });
  const surface = frame.surface("dashboard");
  const usage = frame.surface("usage").tui;
  const ran: string[] = [];
  usage.commands.add({ name: "open", run: () => void ran.push("usage:open") });
  frame.surface("chat").tui.commands.add({ name: "model", run: () => void ran.push("chat:model") });
  let emptyView: EmptyView | undefined;
  let removeUsage: (() => void) | undefined;
  const host = await createHost({
    plugins: [
      {
        name: "chat",
        provides: ["chat"],
        apply: (ctx) => {
          ctx.provide("chat", {
            sessionIdOf: () => undefined,
            setEmptyView: (create: EmptyView) => {
              emptyView = create;
              return () => {};
            },
          } as unknown as ServiceOf<"chat">);
        },
      },
      {
        name: "dashboard",
        uses: ["chat"],
        provides: ["dashboard"],
        apply: (ctx) => apply(withTerminal(ctx, surface.tui)),
      },
      {
        name: "usage",
        uses: ["dashboard"],
        apply: (ctx) => {
          removeUsage = ctx.get("dashboard").addItem({ key: "u", label: "Usage", command: "usage:open" });
          // `m` belongs to the dashboard already, so this item stays out of the menu.
          ctx.get("dashboard").addItem({ key: "m", label: "My model", command: "usage:open" });
        },
      },
    ],
  });
  const composer = new TextEditor({ role: "composer" });
  const pane: ChatPane = { view: composer, composer, sessionId: undefined, transcript: {} as never, running: false };
  const create = emptyView;
  assert(create !== undefined);
  surface.tui.panes.split((mount) => create(mount, pane));
  surface.tui.panes.split(() => composer);
  surface.tui.focus(composer);
  frame.start();
  assert(removeUsage !== undefined);
  return { frame, host, composer, ran, removeUsage };
}

test("an item of another plugin shows in the menu, and its key runs its command", async () => {
  const { frame, host, ran } = await dashboard();
  await using _host = host;
  using _frame = frame;
  const shown = screen(frame);

  assert(shown.includes("unleash your harness"), shown);
  assert(/Usage\s+u/.test(shown), shown);
  assert(/Choose a model\s+m/.test(shown), shown);
  // Other commands of the menu do not exist in this frame, so their rows stay out.
  assert(!shown.includes("Resume a session"), shown);
  assert(!shown.includes("My model"), shown);
  frame.key("u");
  frame.key("m");
  assertEquals(ran, ["usage:open", "chat:model"]);
});

test("the remover takes an item out of the menu, and its key types", async () => {
  const { frame, host, composer, ran, removeUsage } = await dashboard();
  await using _host = host;
  using _frame = frame;

  removeUsage();
  const shown = screen(frame);
  frame.key("u");

  assert(!shown.includes("Usage"), shown);
  assertEquals([ran, composer.state.text], [[], "u"]);
});

test("a typed key turns the menu keys off until the draft resets", async () => {
  const { frame, host, composer, ran } = await dashboard();
  await using _host = host;
  using _frame = frame;

  frame.key("i");
  frame.key("u");
  const typed = composer.state.text;
  composer.reset({ text: "", spans: [], selection: { anchor: 0, head: 0 } });
  frame.key("u");

  assertEquals([typed, ran], ["u", ["usage:open"]]);
});
