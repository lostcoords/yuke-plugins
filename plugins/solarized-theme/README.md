# Solarized theme

A Solarized-inspired theme with Selenized accents, blue UI highlights, and distinct user and tool surfaces. The colors are customized, not an exact reference Solarized palette.

The plugin supports dark and light backgrounds in both truecolor and 256-color terminals. It follows the background reported by your terminal. If the terminal does not report its background, Yuke uses dark. The plugin adds no commands, model tools, timers, credentials, or runtime dependencies.

## Compatibility

The theme uses only the public `tui` capability, `tui.style.theme`, `tui.colors`, `tui.background`, and `background.changed`. These APIs exist in [upstream Yuke at `f9303882`](https://github.com/lostcoords/yuke/tree/f9303882fefb9f7945025b815330edc9f5bfa15a). No personal core patch is required.

The package passes types and native terminal checks on upstream Yuke `0.0.1-nightly.20261012+f930388` and the personal build `0.0.1-dev+15a2a8831f6a.picker5bbb5690b8d6.b20261013073747`. A matching SDK must come from the binary you test. Headless modes load the entry but register no theme.

## Install from a local checkout

Add the theme folder to your profile's `config.json` plugin list. Keep the other entries.

For a checkout at `~/workspace/yuke-plugins`, add this entry with your actual absolute path:

```json
"/absolute/path/to/yuke-plugins/plugins/solarized-theme"
```

Alternatively, copy this complete folder to `~/.config/yuke/plugins/solarized-theme` and add:

```json
"./plugins/solarized-theme"
```

Load only one copy of the plugin. Wait for active work to finish. Save your unsent draft before running `/reload`, because reload can discard it.

Remove the entry and reload to return to Yuke's built-in theme. Removing the entry does not delete the folder.

## Install from GitHub

This method requires a Yuke build with GitHub plugin-source support. Older builds can use a local folder instead.

Add this object to the `plugins` array in `config.json`:

```json
{
  "github": "lostcoords/yuke-plugins",
  "ref": "davafons/solarized-theme",
  "path": "plugins/solarized-theme"
}
```

The extraction branch contains this package before it reaches `main`. Select a published tag or full commit when you need a fixed version. Do not keep the local entry enabled beside the GitHub entry.

Yuke caches the resolved commit. Restart and reload reuse that snapshot. A branch does not update automatically. See [Yuke GitHub sources](https://github.com/lostcoords/yuke/blob/main/docs/profile.md#github-sources) for the source-loading contract of a compatible build.

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

## Verify the package

Run these commands from the repository root. They require Python 3, TypeScript, and an installed Yuke with its matching SDK. The native terminal driver requires POSIX PTY support.

```sh
python3 -B plugins/solarized-theme/tests/check-types.py
python3 -B plugins/solarized-theme/tests/check-theme.py --binary "$(command -v yuke)"
```

Use `--types-dir /path/to/types` to test another SDK. Use `--plugin /path/to/solarized-theme` to test another copy with the same driver.

The native check uses disposable homes, profiles, session stores, and captured terminals. It checks all four palette variants, live background changes, override precedence in both load orders, theme removal and restoration through reload, listener cleanup, headless startup, and clean shutdown. It sends no model requests and does not touch your normal profile or clipboard. It prints the directory that holds its logs and terminal captures.
