# Maintainer checks

These checks are for maintainers. They are not required to install or use the theme.

The runtime uses only public Yuke TUI APIs. It passes types and native terminal checks on upstream `0.0.1-nightly.20261012+f930388` and personal build `0.0.1-dev+15a2a8831f6a.picker5bbb5690b8d6.b20261013073747`.

## Run the checks

Run these commands from the repository root. They require Python 3, TypeScript, and an installed Yuke with its matching SDK. The native terminal driver requires POSIX PTY support.

```sh
python3 -B plugins/solarized-theme/tests/check-types.py
python3 -B plugins/solarized-theme/tests/check-theme.py --binary "$(command -v yuke)"
```

Use `--types-dir /path/to/types` to test another SDK. Use `--plugin /path/to/solarized-theme` to test another copy with the same driver.

The native check uses disposable homes, profiles, session stores, and captured terminals. It checks palette selection, live background changes, override precedence in both load orders, theme removal and restoration through reload, listener cleanup, headless startup, and clean shutdown. It sends no model requests and does not touch your normal profile or clipboard. It prints the directory that holds its logs and terminal captures.

These checks protect runtime behavior, not visual quality. Review the colors in a terminal when changing the palette.
