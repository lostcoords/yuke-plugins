# btw

Ask side questions while Yuke works, without changing the main conversation.

- Runs alongside the main request.
- Reuses the main context and preserves prompt-cache eligibility.
- Saves answers with searchable history.

## Installation

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/btw
```

Run `/reload` while idle. If `btw` is already registered locally, run `yuke plugin remove btw` first; your files and history are kept.

## Usage

Send a main message first, then ask from the composer:

```text
/btw explain the approach you are taking
```

Enter `/btw` or press **Ctrl+K, then B** to open the panel. Use `/btw:history` to browse saved answers.

### Shortcuts

| Key | Action |
| --- | --- |
| Enter | Send a question |
| Esc / Ctrl+C | Close and cancel the pending side request |
| Tab / Shift+Tab | Switch between answer and input |
| Page Up / Page Down | Scroll the answer |
| Ctrl+Y | Copy the answer |
| Ctrl+R | Browse history while idle |

In history, type to search, **Tab** switches session/all history, and **Enter** opens an answer. **Ctrl+D** deletes one record; **Ctrl+X** clears the scope. Both require confirmation.

## Notes

Each question is independent and uses the input context of the latest main round. No tools run, and side questions and answers never enter the main conversation. Cache hits depend on the provider.

History is stored as plain-text JSON under `~/.local/share/yuke-rs/plugins/btw/history/`. It persists until deleted, even if the main session is removed.

## Tests

From the repository root:

```sh
yuke test plugins/btw/tests
```

See [tests/README.md](tests/README.md) for more.

## License

[MIT](../../LICENSE)
