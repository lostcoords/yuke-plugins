# Tests

## Native Yuke tests

```sh
yuke test plugins/btw/tests
```

These use the exported `yuke:test` helpers: `createHost` for controlled model replies and
`createFrame` for the native UI grid, keymap, layout, styles, focus, keyboard, and mouse.
The manifest-loading test also loads the real `plugin.json` and its `src/index.ts` entry.

Coverage includes parallel requests, exact cache-prefix preservation, cancellation,
session cleanup, independent questions, private history, search/deletion, Markdown,
composer sizing, resize reflow, mouse alignment, and draft/focus preservation.

## Optional terminal probe

```sh
python3 plugins/btw/tests/terminal.py
```

This separate development tool launches the installed Yuke in owned PTY processes. It
uses temporary HOME/XDG profiles and a loopback-only mock provider, not personal
credentials or paid requests. Python is not loaded or required by the plugin.

Scenarios cover 32×24 and 100×35, light/dark themes, new/resumed sessions, reloads,
process-restart persistence, flat terminal colors, input growth, and unchanged request
prefixes. A cancellation scenario checks that Escape closes the actual side HTTP stream
while the main stream remains open and no incomplete history is saved.
