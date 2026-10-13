import { env, fs } from "yuke";
import { ChatView } from "yuke:chat";
import { currentPane } from "yuke:session";
import { Text, clip, measure, text } from "yuke:ui";
import { resolveMenu } from "./menu.js";

/** @import { Rect, ViewLike } from "yuke:ui" */
/** @import { MenuRow } from "./menu.js" */
/** @import { ActionSpec } from "./menu.js" */
/** @typedef {{ text: string, x: number, y: number, group: string }} DrawText */
/** @typedef {{ mode(composer: import("yuke:ui").Composer): string, onKey(composer: import("yuke:ui").Composer, ev: { char?: string, mods?: number, code?: string }): boolean }} VimEditor */

const LOGO = [
  "██╗   ██╗██╗   ██╗██╗  ██╗███████╗",
  "╚██╗ ██╔╝██║   ██║██║ ██╔╝██╔════╝",
  " ╚████╔╝ ██║   ██║█████╔╝ █████╗  ",
  "  ╚██╔╝  ██║   ██║██╔═██╗ ██╔══╝  ",
  "   ██║   ╚██████╔╝██║  ██╗███████╗",
  "   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝",
];

class Dashboard extends Text {
  /** @param {MenuRow[]} actions @param {string} footer */
  constructor(actions, footer) {
    super();
    this.actions = actions;
    this.footer = footer;
    this.workspace = "workspace";
    this.revision = 0;
    this.cached = "";
    this.width = -1;
    this.height = -1;
    this.menuX = 0;
    this.menuY = 0;
    this.menuWidth = 0;
    this.menuCount = 0;
    /** @type {DrawText[]} */
    this.rows = [];
  }

  /** @param {Rect} rect */
  layout(rect) {
    this.rect = rect;
    const stamp = this.revision + "\n" + this.text + "\n" + this.workspace + "\n" + this.footer;
    if (this.width === rect.w && this.height === rect.h && this.cached === stamp) return;
    this.cached = stamp;
    this.build();
  }

  build() {
    const { w, h } = this.rect;
    this.width = w;
    this.height = h;
    this.rows.length = 0;
    this.menuCount = 0;
    if (w <= 0 || h <= 0) return;
    const width = Math.min(54, w);
    const left = Math.floor((w - width) / 2);
    const count = this.actions.length;
    const logo = w >= 40 && h >= count + 14 ? LOGO : ["YUKE"];
    const details = h >= logo.length + count + 6;
    const showFooter = h >= logo.length + count + 3;
    const height = logo.length + 1 + (details ? 3 : 0) + count + (showFooter ? 2 : 0);
    let y = Math.max(0, Math.floor((h - height) / 2));
    for (let i = 0; i < logo.length && y < h; i++, y++) {
      const line = clip(logo[i] || "", width);
      this.rows.push({ text: line, x: left + Math.floor((width - measure(line)) / 2), y, group: "DashboardLogo" });
    }
    y++;
    if (details) {
      const home = env.get("HOME");
      const path = home && this.workspace.startsWith(home + "/") ? "~" + this.workspace.slice(home.length) : this.workspace;
      const model = this.text.split("\n", 1)[0] || "no model yet";
      for (const line of [path, model]) {
        const shown = clip(line, width);
        this.rows.push({ text: shown, x: left + Math.floor((width - measure(shown)) / 2), y, group: "DashboardContext" });
        y++;
      }
      y++;
    }
    this.menuX = left;
    this.menuY = y;
    this.menuWidth = width;
    for (let i = 0; i < count && y < h; i++, y++) {
      const action = /** @type {MenuRow} */ (this.actions[i]);
      const key = action.key || "";
      const keyWidth = measure(key);
      const label = clip(action.label, Math.max(0, width - (key ? keyWidth + 2 : 0)));
      this.rows.push({ text: label, x: left, y, group: "DashboardAction" });
      if (key) this.rows.push({ text: key, x: left + width - keyWidth, y, group: "DashboardKey" });
      this.menuCount++;
    }
    if (showFooter && y + 1 < h) {
      const line = clip(this.footer, width);
      this.rows.push({ text: line, x: left + Math.floor((width - measure(line)) / 2), y: y + 1, group: "DashboardContext" });
    }
  }

  draw() {
    for (const row of this.rows) text(this.rect.x + row.x, this.rect.y + row.y, row.text, row.group);
  }
}

/** @param {import("yuke:ui").Tui} tui */
function snapshot(tui) {
  return Object.keys(tui.command.map).map((name) => {
    const entry = tui.command.map[name];
    return { name, desc: entry?.desc ?? null, available: tui.command.available(name) };
  });
}

/** @param {ChatView} pane */
function emptyDraft(pane) {
  return !pane.session.sessionId && pane.transcript.isEmpty() && !pane.composer.text && !pane.composer.hasImages();
}

/** @param {import("yuke").Context} ctx */
export default function (ctx) {
  const tui = ctx.get("tui");
  const vim = /** @type {VimEditor | null} */ (ctx.get("composer-vim"));
  if (tui) tui.style.set({
    DashboardLogo: { fg: "accent", bold: true },
    DashboardAction: { fg: "strongFg" },
    DashboardKey: { fg: "accent" },
    DashboardContext: { link: "UIDim" },
  }, { default: true });

  /** @type {ActionSpec[] | null} */
  let actions = null;
  /** @type {string | null} */
  let footerOverride = null;
  /** @type {string[]} */
  let fileFaults = [];
  /** @type {MenuRow[]} */
  let rows = [];
  let started = false;
  const reported = new Set();
  /** @type {Map<ChatView, { title: Text, hint: Text, dashboardTitle: Text, dashboard: Dashboard }>} */
  const panes = new Map();
  let workspace = "workspace";

  /** @param {unknown} value @param {string[]} faults @returns {ActionSpec | null} */
  const accept = (value, faults) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      faults.push("A row must be an object");
      return null;
    }
    const action = /** @type {Record<string, unknown>} */ (value);
    if (typeof action.command !== "string" || !action.command) {
      faults.push("A row needs a command name");
      return null;
    }
    if (action.label !== undefined && typeof action.label !== "string") {
      faults.push(action.command + " label must be text");
      return null;
    }
    if (action.key !== undefined && (typeof action.key !== "string" || [...action.key].length !== 1)) {
      faults.push(action.command + " key must be one character");
      return null;
    }
    /** @type {ActionSpec} */
    const parsed = { command: action.command };
    if (typeof action.label === "string") parsed.label = action.label;
    if (typeof action.key === "string") parsed.key = action.key;
    return parsed;
  };

  const publish = () => {
    if (!tui) return;
    const menu = resolveMenu(snapshot(tui), actions ? { actions } : null);
    rows = menu.rows;
    const footer = footerOverride || (rows.some((row) => row.key) ? "unleash your harness" : "click a row or type a prompt");
    if (started) {
      for (const fault of fileFaults.concat(menu.faults)) {
        if (reported.has(fault)) continue;
        reported.add(fault);
        ctx.print(fault);
      }
    }
    for (const saved of panes.values()) {
      saved.dashboard.actions = rows;
      saved.dashboard.footer = footer;
      saved.dashboard.revision++;
    }
    tui.root.invalidate();
  };

  /** @param {ViewLike} pane */
  const attach = (pane) => {
    if (!(pane instanceof ChatView)) return;
    if (!panes.has(pane)) {
      const dashboard = new Dashboard(rows, footerOverride || (rows.some((row) => row.key) ? "unleash your harness" : "click a row or type a prompt"));
      dashboard.workspace = workspace;
      const dashboardTitle = new Text();
      panes.set(pane, { title: pane.title, hint: pane.hint, dashboardTitle, dashboard });
      pane.title = dashboardTitle;
      pane.hint = dashboard;
    }
    tui.root.invalidate();
  };

  /** @param {{ char?: string, mods?: number, code?: string }} ev */
  const rowFor = (ev) => {
    if (ev.code !== "char" || ev.mods || !ev.char) return null;
    return rows.find((item) => item.key === ev.char) || null;
  };
  ctx.provide("yuke-dashboard", {
    /** @param {{ footer?: string, rows?: unknown[] }} options */
    setup(options = {}) {
      actions = [];
      fileFaults = [];
      if (options.footer !== undefined) {
        if (typeof options.footer !== "string" || !options.footer) throw new TypeError("footer must be text");
        footerOverride = options.footer;
      }
      for (const item of options.rows || []) {
        const action = accept(item, fileFaults);
        if (action) actions.push(action);
      }
      publish();
    },
    /** @param {unknown} item */
    row(item) {
      if (!actions) actions = [];
      const action = accept(item, fileFaults);
      if (action) actions.push(action);
      publish();
    },
    /** @param {string} text */
    footer(text) {
      if (typeof text !== "string" || !text) throw new TypeError("footer must be text");
      footerOverride = text;
      publish();
    },
  });
  if (!tui) return;
  ctx.advise(Object.getPrototypeOf(tui.command), "add", "after", () => publish());
  ctx.advise(ChatView.prototype, "onKey", "around", function (next, ev) {
    if (!(this instanceof ChatView) || !emptyDraft(this)) return next(ev);
    const row = rowFor(ev);
    if (!row) return next(ev);
    tui.command.perform(row.command);
    return true;
  }, { order: -100 });
  if (vim) ctx.advise(vim, "onKey", "around", (next, composer, ev) => {
    const pane = currentPane();
    if (!(pane instanceof ChatView) || pane.composer !== composer || !emptyDraft(pane)) return next(composer, ev);
    const row = rowFor(ev);
    if (!row) return next(composer, ev);
    tui.command.perform(row.command);
    return true;
  }, { order: -100 });

  ctx.on("pane.focused", attach);
  ctx.on("pane.closed", (pane) => { if (pane instanceof ChatView) panes.delete(pane); });
  ctx.on("session.current.changed", () => {
    const pane = currentPane();
    if (pane instanceof ChatView) attach(pane);
  });
  ctx.on("ui.started", () => { started = true; publish(); });
  const newCommand = tui.command.map["chat:new"];
  if (newCommand) ctx.advise(newCommand, "run", "after", () => {
    const pane = currentPane();
    if (pane) attach(pane);
  });
  const leaves = tui.root.root_node?.leaves() || [];
  for (const leaf of leaves) {
    if (leaf?.shape?.type === "leaf") attach(leaf.shape.view);
  }
  publish();
  ctx.own(() => {
    for (const [pane, saved] of panes) {
      if (pane.title === saved.dashboardTitle) pane.title = saved.title;
      if (pane.hint === saved.dashboard) pane.hint = saved.hint;
    }
    panes.clear();
    tui.root.invalidate();
  });
  fs.stat(".").then((directory) => {
    if (!ctx.alive || !directory?.isDirectory) return;
    workspace = directory.path.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ");
    for (const saved of panes.values()) {
      saved.dashboard.workspace = workspace;
      saved.dashboard.revision++;
    }
    tui.root.invalidate();
  }).catch(() => {});
  ctx.on("chat.press", (pane, ev) => {
    if (pane.session.sessionId || !pane.transcript.isEmpty()) return;
    const dashboard = panes.get(pane)?.dashboard;
    if (!dashboard) return;
    const row = ev.row - dashboard.rect.y - dashboard.menuY;
    const col = ev.col - dashboard.rect.x - dashboard.menuX;
    if (row < 0 || row >= dashboard.menuCount || col < 0 || col >= dashboard.menuWidth) return;
    tui.root.focusView(pane);
    const action = dashboard.actions[row];
    return action ? tui.command.perform(action.command) || true : false;
  });
}
