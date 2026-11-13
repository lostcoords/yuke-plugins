import type { PluginContext, ServiceOf, Services } from "yuke:plugins";
import {
  assert,
  assertEquals,
  type FrameTest,
  type Host,
  type PluginUnderTest,
  type ScreenCell,
  waitForSettled,
} from "yuke:test";
import type { Tui } from "yuke:tui";

/** The text of one row of cells. */
export function rowText(row: readonly ScreenCell[]): string {
  return row.map((cell) => cell.text).join("");
}

/** Draw the frame, and give the text of each row. */
export function rows(frame: FrameTest): string[] {
  frame.draw();
  return frame.frame.cells.map(rowText);
}

/** Draw the frame, and give its text with one row per line. */
export function screen(frame: FrameTest): string {
  return rows(frame).join("\n");
}

/** Draw the frame, and give the cells of the first row that holds `text`. */
export function findRow(frame: FrameTest, text: string): readonly ScreenCell[] | undefined {
  frame.draw();
  return frame.frame.cells.find((row) => rowText(row).includes(text));
}

/** Let the host work, then check that the screen shows `text`. */
export async function waitForScreen(frame: FrameTest, text: string): Promise<void> {
  await waitForSettled();
  const shown = screen(frame);
  assert(shown.includes(text), shown);
}

/** A chat service without behavior. `session` names the session that the chat shows. */
export function fakeChat(session: () => string | undefined = () => undefined): PluginUnderTest {
  return {
    name: "chat",
    provides: ["chat"],
    apply: (ctx) => {
      ctx.provide("chat", {
        session,
        show: async () => {},
        addChangeListener: () => () => {},
        addPaneWatcher: () => () => {},
        addCompletionProvider: () => () => {},
        addComposerView: () => () => {},
        setPresentation: () => () => {},
        addReadOnly: () => () => {},
        setComposerFrame: () => () => {},
        setEmptyView: () => () => {},
      });
    },
  };
}

/** Give the plugin the terminal of a frame surface in place of the headless one of the test host. */
export function withTerminal(ctx: PluginContext, tui: Tui): PluginContext {
  // The fake chat service omits the style registrations of the bundled chat.
  tui.styles.add({
    "chat.title": { fg: "accent", bold: true },
    "chat.hint": { fg: "accent" },
    "chat.meta": { dim: true },
  });
  const get = <K extends keyof Services & string>(name: K): ServiceOf<K> =>
    name === "tui" ? (tui as ServiceOf<K>) : ctx.get(name);
  return { ...ctx, get };
}

/** Let the host work, then check that the fake model got `count` requests. */
export async function waitForRequests(host: Host, count: number): Promise<void> {
  await waitForSettled();
  assertEquals(host.requests.length, count);
}
