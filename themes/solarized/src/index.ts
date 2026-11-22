import type { PluginContext } from "yuke:plugins";
import type { Theme } from "yuke:tui";

const theme = {
  dark: {
    palette: {
      fg: "#adbcbc",
      bg: "#082b34",
      surfaceFg: "#cad8d9",
      strongFg: "#cad8d9",
      accent: "#4695f7",
      accentMuted: "#0d303a",
      surface: "#0d303a",
      warn: "#dbb32d",
      danger: "#ff665c",
      pendingBg: "#262f22",
      errorBg: "#34292e",
      diffAddBg: "#10382f",
      diffDelBg: "#36252c",
    },
    palette256: {
      fg: 248,
      bg: 234,
      surfaceFg: 252,
      strongFg: 252,
      accent: 75,
      accentMuted: 236,
      surface: 235,
      warn: 179,
      danger: 209,
      pendingBg: 235,
      errorBg: 52,
      diffAddBg: 235,
      diffDelBg: 52,
    },
    groups: {
      "dialog.title": {
        fg: "#4695f7",
        bold: true,
      },
      "editor.placeholder": {
        fg: "#8fa7aa",
        dim: false,
      },
      bar: {
        fg: "#4695f7",
        dim: false,
      },
      "chat.rule": {
        fg: "#8fa7aa",
        dim: false,
      },
      "chat.thought": {
        fg: "#b7a2e8",
        dim: false,
        italic: true,
      },
      "chat.user": {
        fg: "#eee8d5",
        bg: "#28434d",
        dim: false,
      },
      "chat.meta": {
        fg: "#b0c1c1",
        dim: false,
      },
      "chat.title": {
        fg: "#4695f7",
        bold: true,
      },
      "chat.subject": {
        fg: "#41c7b9",
        dim: false,
      },
      "chat.tool.output": {
        fg: "#8fa7aa",
        dim: false,
      },
      "chat.hint": {
        fg: "#8fa7aa",
        dim: false,
      },
      "chat.diff.add": {
        fg: "#75b938",
      },
      "chat.diff.context": {
        fg: "#8fa7aa",
        dim: false,
      },
      "markdown.heading": {
        fg: "#4695f7",
        bold: true,
      },
      "markdown.strong": {
        fg: "#cad8d9",
      },
      "markdown.strongEmphasis": {
        fg: "#cad8d9",
      },
      "markdown.code": {
        fg: "#dbb32d",
        dim: false,
      },
      "markdown.codeBlock": {
        fg: "#41c7b9",
        dim: false,
      },
      "markdown.quote": {
        fg: "#75b938",
        dim: false,
      },
      "markdown.listMark": {
        fg: "#4695f7",
        dim: false,
      },
      "markdown.rule": {
        fg: "#8fa7aa",
        dim: false,
      },
      "markdown.tableBorder": {
        fg: "#8fa7aa",
        dim: false,
      },
    },
  },
  light: {
    palette: {
      fg: "#405157",
      bg: "#fdf6e3",
      surfaceFg: "#304147",
      strongFg: "#203137",
      accent: "#006599",
      accentMuted: "#d9e5de",
      surface: "#eee8d5",
      warn: "#765c00",
      danger: "#b52b28",
      pendingBg: "#f4ebca",
      errorBg: "#f6dfd9",
      diffAddBg: "#e3ecd6",
      diffDelBg: "#f6dfd9",
    },
    palette256: {
      fg: 239,
      bg: 230,
      surfaceFg: 238,
      strongFg: 237,
      accent: 24,
      accentMuted: 188,
      surface: 187,
      warn: 58,
      danger: 124,
      pendingBg: 187,
      errorBg: 224,
      diffAddBg: 194,
      diffDelBg: 224,
    },
    groups: {
      "dialog.title": {
        fg: "#006599",
        bold: true,
      },
      "editor.placeholder": {
        fg: "#536368",
        dim: false,
      },
      bar: {
        fg: "#006599",
        dim: false,
      },
      "chat.rule": {
        fg: "#536368",
        dim: false,
      },
      "chat.thought": {
        fg: "#724b9e",
        dim: false,
        italic: true,
      },
      "chat.user": {
        fg: "#304147",
        bg: "#d4e2df",
        dim: false,
      },
      "chat.meta": {
        fg: "#536368",
        dim: false,
      },
      "chat.title": {
        fg: "#006599",
        bold: true,
      },
      "chat.subject": {
        fg: "#006f66",
        dim: false,
      },
      "chat.tool.output": {
        fg: "#536368",
        dim: false,
      },
      "chat.hint": {
        fg: "#536368",
        dim: false,
      },
      "chat.diff.add": {
        fg: "#3b6b14",
      },
      "chat.diff.context": {
        fg: "#536368",
        dim: false,
      },
      "markdown.heading": {
        fg: "#006599",
        bold: true,
      },
      "markdown.strong": {
        fg: "#203137",
      },
      "markdown.strongEmphasis": {
        fg: "#203137",
      },
      "markdown.code": {
        fg: "#765c00",
        dim: false,
      },
      "markdown.codeBlock": {
        fg: "#006f66",
        dim: false,
      },
      "markdown.quote": {
        fg: "#3b6b14",
        dim: false,
      },
      "markdown.listMark": {
        fg: "#006599",
        dim: false,
      },
      "markdown.rule": {
        fg: "#536368",
        dim: false,
      },
      "markdown.tableBorder": {
        fg: "#536368",
        dim: false,
      },
    },
  },
} satisfies Theme;

/** Add the `solarized` theme. `/themes` selects it. */
export function apply(ctx: PluginContext): undefined {
  ctx.get("tui")?.styles.addTheme("solarized", theme);
}
