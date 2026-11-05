# Vim

Vim editing for Yuke composers and read-only navigation through conversations.

## Installation

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/vim
```

Run `/reload` while idle.

## Usage

The composer starts in Insert mode. Press **Esc** or **Ctrl+[** for Normal mode. The status bar shows the current mode.

| Action | Keys |
| --- | --- |
| Insert | `i`, `a`, `I`, `A`, `o`, `O` |
| Move | `h`, `j`, `k`, `l`, `w`, `b`, `e`, `0`, `$`, `gg`, `G` |
| Edit | `d`, `c`, `y`, `p`, `x`, `r` |
| Select | `v`, `V` |
| Undo / redo / repeat | `u`, `Ctrl+R`, `.` |
| Search | `Alt+/`, `?`, `n`, `N` |

Enter submits as usual. In Normal mode, `/` starts a slash command. Use Insert mode for terminal paste.

## Transcript navigation

Press **Tab** in Normal mode to focus the transcript in the same widget group.
Press **Tab** again to return to the composer.

- Use motions, counts, **v**, **V**, and **y** to select and copy text.
- Registers are shared with composers. Yank in the transcript, then use **p** in the composer.
- **gy** copies the source of the selection or current display line, including text hidden by a clipping marker.
- **J** and **K** move between visible sections. **Enter** activates the current position, such as a tool fold or link.
- Use **Alt+/**, **?**, **n**, **N**, **\***, and **#** to search. Search is literal and case-sensitive.
- Local marks keep source positions through wrapping and resize. Tab restores the previous transcript caret.

Transcript navigation requires Yuke with the `elision` source mapping for clipped tool headings.

## Composer integration

The plugin provides `composer-vim` in the terminal interface.
Add `composer-vim` to a consumer plugin's `uses` list before calling `ctx.get("composer-vim")`.
The TypeScript service declaration is in `src/service.ts`.

- `mode(editor)` reads the mode. A null editor gives an empty string.
- `setMode(editor, "insert" | "normal")` sets the mode and cancels a pending command.
- `pending(editor)` reports whether Vim waits for a command continuation.
- `cancel(editor)` cancels a command, ends an Insert undo group, and leaves Visual mode without changing text.
- `onMode(listener)` observes mode changes. Call its disposer when the consumer stops.

The service is absent outside the terminal interface.

## Checks

```sh
yuke test plugins/vim/tests
python3 plugins/vim/scripts/parity.py
python3 plugins/vim/tests/terminal.py
```

The parity script compares 587 sequences with an installed Vim executable.
The terminal check covers editing, reload, transcript focus, and shared registers in an isolated profile.
Set `YUKE_BINARY` to test another Yuke executable. These checks make no model requests.

[MIT](../../LICENSE) · [Vim license](LICENSE.vim.txt)
