/**
 * The plugin `dashboard`. An empty chat pane shows a centered start screen: the icon, the name, the folder, the model,
 * the version, and a menu of one-key actions. A menu key works while the pane has no session and the draft is empty,
 * before the first typed key or in Vim Normal mode. `i` types a message that starts with a menu key.
 *
 * The service `dashboard` lets another plugin add an item to the menu.
 */

import type { PluginContext } from "yuke:plugins";
import { env } from "yuke:process";
import { type Canvas, fit, type KeyEvent, measure, type Style, strokeOf, TextEditor } from "yuke:tui";
import { ACCENT, drawIcon, ICON_ROWS, ICON_WIDTH } from "./icon.ts";

/** One row of the menu: the key, its label, and the command that the key runs. */
export interface DashboardItem {
  /** One key stroke, such as `u`. */
  readonly key: string;
  readonly label: string;
  /** The full name of a command, such as `usage:open`. */
  readonly command: string;
}

/** The menu of the start screen. */
export interface Dashboard {
  /**
   * Add `item` to the menu, above the commands and the quit, and give the remover. The menu shows an item only while
   * its command exists. When two items have one key, the earlier one keeps it.
   */
  readonly addItem: (item: DashboardItem) => () => void;
}

declare module "yuke:plugins" {
  interface Services {
    readonly dashboard: Dashboard;
  }
}

const HEAD: readonly DashboardItem[] = [
  { key: "r", label: "Resume a session", command: "sessions:open" },
  { key: "m", label: "Choose a model", command: "chat:model" },
  { key: "t", label: "Themes", command: "themes:open" },
  { key: "l", label: "Sign in", command: "login:login" },
];

const TAIL: readonly DashboardItem[] = [
  { key: "c", label: "Commands", command: "dashboard:commands" },
  { key: "q", label: "Quit", command: "core:quit" },
];

const DIM: Style = { dim: true };
const MENU_WIDTH = 36;

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return measure(text) <= width ? text : `${text.slice(0, fit(text, width - 1))}…`;
}

export function apply(ctx: PluginContext): undefined {
  // The service exists in each mode, so a plugin that adds an item needs no check of the mode.
  const added: DashboardItem[] = [];
  ctx.provide("dashboard", {
    addItem: (item) => {
      const entry = { ...item };
      added.push(entry);
      return () => {
        const index = added.indexOf(entry);
        if (index >= 0) added.splice(index, 1);
      };
    },
  });

  const tui = ctx.get("tui");
  if (tui === undefined) return;
  const chat = ctx.get("chat");
  // Terminal.app finds no font with sextant glyphs and draws boxes.
  const icon = env.get("TERM_PROGRAM") !== "Apple_Terminal";
  const home = env.get("HOME");
  // A composer that took a typed key since its last reset. Its menu keys type, until Vim Normal mode.
  const typed = new WeakSet<TextEditor>();

  const status = (id: string): string | undefined => tui.status.list().find((item) => item.id === id)?.text;
  const items = (): DashboardItem[] => {
    const names = new Set(tui.commands.list().map((row) => row.name));
    const keys = new Set<string>();
    return [...HEAD, ...added, ...TAIL].filter((item) => {
      if (!names.has(item.command) || keys.has(item.key)) return false;
      keys.add(item.key);
      return true;
    });
  };
  const armed = (editor: TextEditor, sessionId: string | undefined): boolean => {
    if (sessionId !== undefined || editor.state.text !== "" || editor.state.spans.length > 0) return false;
    if (editor.contexts.includes("vim-normal")) return true;
    // Visual mode or another mode of Vim keeps its keys.
    const vim = editor.contexts.find((context) => context.startsWith("vim-"));
    return (vim === undefined || vim === "vim-insert") && !typed.has(editor);
  };

  const stopView = chat.setEmptyView((_mount, pane) => {
    let menuRow = -1;
    let menuColumn = 0;
    let shown: DashboardItem[] = [];
    return {
      draw: (canvas: Canvas) => {
        shown = items();
        const active = armed(pane.composer, pane.sessionId);
        let folder = status("chat:folder") ?? tui.startup.folder;
        if (home !== undefined && folder.startsWith(`${home}/`)) folder = `~${folder.slice(home.length)}`;
        const model = status("chat:model") ?? "no model yet";
        // The text lines take the whole pane, so a long nightly version shows whole. The menu keeps a narrow column.
        const textWidth = canvas.width - 2;
        const width = Math.min(MENU_WIDTH, textWidth);
        const withMenu = canvas.height >= shown.length + 11 && width > 4;
        const withIcon = icon && canvas.height >= ICON_ROWS + 1 + (withMenu ? shown.length + 11 : 6);
        // The title and the subtitle, an empty row, and the folder, the model, and the version.
        const height = (withIcon ? ICON_ROWS + 1 : 0) + 6 + (withMenu ? 1 + shown.length + 2 : 0);
        let row = Math.max(0, Math.floor((canvas.height - height) / 2));
        const center = (text: string, style: Style): void => {
          const line = clip(text, textWidth);
          canvas.text(Math.floor((canvas.width - measure(line)) / 2), row, line, style);
          row += 1;
        };
        if (withIcon) {
          drawIcon(canvas, Math.floor((canvas.width - ICON_WIDTH) / 2), row);
          row += ICON_ROWS + 1;
        }
        center("yuke", { ...ACCENT, bold: true });
        center("unleash your harness", DIM);
        row += 1;
        center(folder, DIM);
        center(model, DIM);
        center(tui.startup.version, DIM);
        menuRow = -1;
        if (withMenu) {
          row += 1;
          menuRow = row;
          menuColumn = Math.floor((canvas.width - width) / 2);
          for (const item of shown) {
            canvas.text(menuColumn, row, clip(item.label, width - 2), active ? undefined : DIM);
            canvas.text(menuColumn + width - measure(item.key), row, item.key, active ? ACCENT : DIM);
            row += 1;
          }
          row += 1;
          if (active) center("i types a message", DIM);
          else if (pane.composer.state.text === "" && pane.sessionId === undefined)
            center("esc for the menu keys", DIM);
        }
      },
      onMouse: (event) => {
        if (event.action !== "press" || event.button !== "left" || menuRow < 0) return false;
        const item = shown[event.row - menuRow];
        if (item === undefined || event.column < menuColumn || event.column >= menuColumn + MENU_WIDTH) return false;
        tui.focus(pane.composer);
        return tui.commands.run(item.command);
      },
    };
  });
  ctx.signal.addEventListener("abort", stopView, { once: true });

  tui.commands.add({
    name: "commands",
    description: "Choose a command",
    run: async () => {
      const selected = await tui.select({
        title: "Commands",
        items: tui.commands.list().filter((row) => row.enabled),
        label: (row) => (row.description === undefined ? row.name : `${row.name} · ${row.description}`),
        signal: ctx.signal,
      });
      if (selected !== undefined) tui.commands.run(selected.name);
    },
  });

  tui.widgets.addWatcher((mount) => {
    const editor = mount.widget;
    if (!(editor instanceof TextEditor) || editor.role !== "composer") return;
    const sessionId = (): string | undefined =>
      mount.pane === undefined ? undefined : chat.sessionIdOf(mount.pane.view);
    // A plugin later in the list extends the composer later, so this handler runs before the one of Vim.
    const extension = editor.extend(mount.signal);
    extension.addChangeListener((change) => {
      if (change.kind === "reset") typed.delete(editor);
    });
    extension.addKeyHandler((event: KeyEvent) => {
      if (tui.keys.pending() !== "" || !armed(editor, sessionId())) return false;
      const key = strokeOf(event);
      const item = items().find((entry) => entry.key === key);
      if (item !== undefined) return tui.commands.run(item.command);
      const modified = event.modifiers.ctrl || event.modifiers.alt || event.modifiers.super;
      if (modified || event.text === "") return false;
      typed.add(editor);
      // Without Vim Normal mode, `i` only disarms the menu, so the next key types.
      return key === "i" && !editor.contexts.includes("vim-normal");
    }, "beforeKeymap");
    return () => extension.close();
  });
  return undefined;
}
