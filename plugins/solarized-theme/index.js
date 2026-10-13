//! The personal solarized-theme plugin on manifest-owned TUI registrations.
/** @typedef {Parameters<import("yuke:ui").Tui["style"]["setPalette"]>[0]} Palette */

// Selenized accents keep the Solarized hues distinct on the darker reading surfaces.
/** @type {Record<"truecolor" | "256", Record<"dark" | "light", Palette>>} */
const palettes = {
  truecolor: {
    dark: {
      fg: "#adbcbc", bg: "#082b34", surfaceFg: "#cad8d9", strongFg: "#cad8d9",
      accent: "#4695f7", accentMuted: "#0d303a", surface: "#0d303a",
      userBg: "#28434d", userFg: "#eee8d5", metaFg: "#b0c1c1", toolBg: "#10302c",
      muted: "#8fa7aa", cyan: "#41c7b9", yellow: "#dbb32d", green: "#75b938", violet: "#b7a2e8",
      warn: "#dbb32d", danger: "#ff665c", pendingBg: "#262f22", errorBg: "#34292e",
      diffAddBg: "#10382f", diffDelBg: "#36252c",
    },
    light: {
      fg: "#405157", bg: "#fdf6e3", surfaceFg: "#304147", strongFg: "#203137",
      accent: "#006599", accentMuted: "#d9e5de", surface: "#eee8d5",
      userBg: "#d4e2df", userFg: "#304147", metaFg: "#536368", toolBg: "#e8ecdf",
      muted: "#536368", cyan: "#006f66", yellow: "#765c00", green: "#3b6b14", violet: "#724b9e",
      warn: "#765c00", danger: "#b52b28", pendingBg: "#f4ebca", errorBg: "#f6dfd9",
      diffAddBg: "#e3ecd6", diffDelBg: "#f6dfd9",
    },
  },
  "256": {
    dark: {
      fg: 248, bg: 234, surfaceFg: 252, strongFg: 252,
      accent: 75, accentMuted: 236, surface: 235,
      userBg: 237, userFg: 230, metaFg: 252, toolBg: 235,
      muted: 247, cyan: 80, yellow: 179, green: 113, violet: 183,
      warn: 179, danger: 209, pendingBg: 235, errorBg: 52,
      diffAddBg: 235, diffDelBg: 52,
    },
    light: {
      fg: 239, bg: 230, surfaceFg: 238, strongFg: 237,
      accent: 24, accentMuted: 188, surface: 187,
      userBg: 152, userFg: 237, metaFg: 239, toolBg: 194,
      muted: 240, cyan: 23, yellow: 58, green: 22, violet: 60,
      warn: 58, danger: 124, pendingBg: 187, errorBg: 224,
      diffAddBg: 194, diffDelBg: 224,
    },
  },
};

const groups = {
  UIBorder: { fg: "accent", dim: false },
  UITitle: { fg: "accent", bold: true },
  UIComposerPromptInactive: { fg: "muted", dim: false },
  UIComposerPlaceholder: { fg: "muted", dim: false },
  UIDim: { fg: "muted", dim: false },
  YukeStatus: { fg: "accent", dim: false },
  YukeBar: { fg: "accent", dim: false },
  YukeRule: { fg: "muted", dim: false },
  YukeEmpty: { fg: "muted", dim: false },
  TxThought: { fg: "violet", dim: false, italic: true },
  TxUser: { fg: "userFg", bg: "userBg", dim: false },
  TxMeta: { fg: "metaFg", dim: false },
  TxToolTitle: { fg: "accent", bold: true },
  TxToolArg: { fg: "cyan", dim: false },
  TxToolOutput: { fg: "muted", dim: false },
  TxToolHint: { fg: "muted", dim: false },
  TxToolSuccessBg: { bg: "toolBg" },
  TxDiffAdd: { fg: "green" },
  TxDiffContext: { fg: "muted", dim: false },
  MdHeading: { fg: "accent", bold: true },
  MdStrong: { fg: "strongFg" },
  MdStrongEm: { fg: "strongFg" },
  MdCode: { fg: "yellow", dim: false },
  MdCodeBlock: { fg: "cyan", dim: false },
  MdQuote: { fg: "green", dim: false },
  MdListMark: { fg: "accent", dim: false },
  MdRule: { fg: "muted", dim: false },
  MdTableBorder: { fg: "muted", dim: false },
};

/** Solarized theme with blue UI accents and readable transcript colors. It follows the terminal background and color depth. */
/** Register the personal solarized-theme surface when TUI exists. The context owns registrations; a host failure throws. @param {import("yuke").Context} ctx */
export default function (ctx) {
  const tui = ctx.get("tui");
  if (!tui) return;
  const apply = () => tui.style.theme({
    palette: palettes[tui.colors][tui.background],
    groups,
  });
  apply();
  ctx.on("background.changed", apply);
}
