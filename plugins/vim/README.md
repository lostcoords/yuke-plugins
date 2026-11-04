# Vim

Vim editing for Yuke composers. Transcript navigation is not supported.

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

[MIT](../../LICENSE) · [Vim license](LICENSE.vim.txt)
