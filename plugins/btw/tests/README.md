# Tests

## Native Yuke tests

```sh
yuke test ~/.config/yuke/plugins/btw/tests
```

These use the exported `yuke:test` helpers: `createHost` for controlled model replies and
`createFrame` for the native UI grid, keymap, layout, styles, focus, keyboard, and mouse.
The manifest-loading test also loads the real `plugin.json` and its `src/index.ts` entry.

Coverage includes parallel requests, exact cache-prefix preservation, cancellation,
session cleanup, independent questions, private history, search/deletion, Markdown,
composer sizing, resize reflow, mouse alignment, and draft/focus preservation.

## Optional terminal probe

```sh
python3 ~/.config/yuke/plugins/btw/tests/terminal.py
```

This separate development tool launches the installed Yuke in owned PTY processes. It
uses temporary HOME/XDG profiles and a loopback-only mock provider, not personal
credentials or paid requests. Python is not loaded or required by the plugin.

Scenarios cover 32×24 and 100×35, light/dark themes, new/resumed sessions, reloads,
process-restart persistence, flat terminal colors, input growth, and unchanged request
prefixes. A cancellation scenario checks that Escape closes the actual side HTTP stream
while the main stream remains open and no incomplete history is saved.

## Verification record

On 2026-10-31 with `yuke 0.0.1-nightly.20261030+68827951f253`:

- 42 plugin host/storage/frame tests passed.
- 4 upstream side-request host tests passed.
- 10 real-terminal scenarios passed.
- Strict TypeScript 7.0.2 and Biome checks passed.

These checks do not prove heap-leak freedom, live-provider cache hits, or billing savings.
The older, version-pinned lifecycle review is retained only as an optional
[maintainer reference](../docs/request-lifecycle.md).
