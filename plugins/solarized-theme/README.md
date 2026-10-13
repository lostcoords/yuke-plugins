# Solarized theme

A Solarized-inspired theme with Selenized accents, blue UI highlights, and distinct user and tool surfaces. The colors are customized, not an exact reference Solarized palette.

The theme supports dark and light backgrounds in both truecolor and 256-color terminals. It follows the background reported by your terminal. If the terminal does not report its background, Yuke uses dark.

## Install

Use a Yuke build with GitHub plugin-source support. Add this object to the `plugins` array in your profile's `config.json`. Keep the other entries.

```json
{
  "github": "lostcoords/yuke-plugins",
  "ref": "davafons/solarized-theme",
  "path": "plugins/solarized-theme"
}
```

The branch contains this package until it reaches `main`. Select a published tag or full commit when you need a fixed version. Load only one copy of the theme.

Wait for active work to finish. Save your unsent draft before running `/reload`, because reload can discard it. Remove the entry and reload to return to Yuke's built-in theme.

Yuke caches the resolved commit. A branch does not update automatically. See [Yuke GitHub sources](https://github.com/lostcoords/yuke/blob/main/docs/profile.md#github-sources) for the source-loading contract of a compatible build.

## Select color depth

The theme follows `tui.colors`. Keep `"auto"` for Yuke's terminal detection, or select `"truecolor"` or `"256"` in your profile:

```json
{
  "tui": {
    "colors": "256"
  }
}
```

Merge this setting into your existing configuration. Do not replace the rest of the file. Reload applies a color-depth change.

## Customize through another plugin

Other plugins do not need to import this theme or declare it as a dependency. Use semantic palette names and default highlight groups for normal integration.

An explicit `tui.style.set` or `setPalette` override sits above the active theme, even if the override registers first. Background changes keep those overrides. Their owning plugin removes them on unload.

For example, another plugin can override thought text and the accent:

```js
/** Register owned style overrides. No TUI skips them. Registration failures throw. @param {import("yuke").Context} ctx */
export default function(ctx) {
  const tui = ctx.get("tui");
  if (!tui) return;
  tui.style.set({ TxThought: { fg: "#112233", bold: true } });
  tui.style.setPalette({ accent: "#abcdef" });
}
```

That plugin's manifest must list `"tui"` in `extensions["sh.yuke"].uses`. Use 256-color indices instead of hex colors if your override must support terminals without truecolor.

Only one theme is active. Another plugin's `theme()` call replaces this theme. Do not load several automatic theme plugins together. Use `set` and `setPalette` for individual overrides rather than another `theme()` call.
