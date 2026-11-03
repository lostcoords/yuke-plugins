# Vim

Vim editing for Yuke composers through public text widget APIs.

The composer port works now. Transcript navigation is not implemented yet.
The plugin does not replace methods, change prototypes, or access chat internals.
A missing public operation requires a core API change, not a plugin workaround.

## Installation

Install it from the plugin repository:

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/vim
```

Run `/reload` while idle.
For local development, add the absolute `plugins/vim` folder to the `plugins` list in your Yuke `config.json`.
The plugin has no runtime dependencies.
It does nothing outside the terminal interface.

## Modes and keys

Each composer starts in Insert mode.
`Esc` or `Ctrl+[` enters Normal mode.
The status bar shows the mode of the focused composer.
Normal and Visual modes use a block cursor.
Insert mode uses a bar cursor.

| Group | Keys |
| --- | --- |
| Insert commands | `i`, `a`, `I`, `A`, `o`, `O` |
| Selection modes | `v`, `V`, `o` to exchange endpoints, `gv` to restore the last selection |
| Character and line motions | `h`, `l`, arrows, Space, `0`, `^`, `$`, `j`, `k`, `gj`, `gk`, `gg`, `G`, counted `%` |
| Word motions | `w`, `b`, `e`, `W`, `B`, `E`, `ge`, `gE` |
| Character finds | `f`, `F`, `t`, `T`, followed by a character; `;` and `,` repeat the find |
| Structural motions | `%`, `{`, `}` |
| Operators | `d`, `c`, `y`, `gu`, `gU`, `g~`, `>`, `<` |
| Whole-line operators | `dd`, `cc`, `yy`, `guu`, `gUU`, `g~~`, `>>`, `<<` |
| Short edits | `x`, `X`, `s`, `S`, `D`, `C`, `Y`, `p`, `P`, `r`, `~`, `J`, `gJ` |
| Local marks | `ma` through `mz`, apostrophe jumps, backtick jumps |
| Search | `Alt+/`, `?`, `n`, `N`, `*`, `#`, `g*`, `g#` |
| History | `u`, Normal-mode `Ctrl+R`, `.` |
| Insert commands with control keys | `Ctrl+W` deletes a word; `Ctrl+R` followed by a register inserts its text |

Counts before and after an operator multiply: `2d2w` deletes four words.
An invalid continuation cancels the pending command and consumes that key.
Counts over 10,000 cancel the command.
Counted `%` accepts percentages from 1 through 100.
A pending command has no timeout.
Focus changes, mouse input, and paste cancel it.

`j` and `k` move through logical lines.
`gj` and `gk` move through display rows.
The preferred column counts terminal cells.
Character motions and edits keep complete graphemes and complete editor spans.
Emoji and combining sequences therefore remain whole, unlike some native Vim operations.

Use `i` or `a` with a text object:

- `w` and `W` select a word or WORD.
- Double quotes, apostrophes, and backticks select quoted text on one line.
- Parentheses, square brackets, and braces select bracket pairs.
- `b` names parentheses; `B` names braces.

Examples: `ciw`, `daW`, `ci"`, `yi[`, and `d2i(`.
A bracket count selects an outer enclosing pair.
`2i"` includes the quote characters; it does not select another quoted string.

## Integration with Yuke

`Esc` and `Ctrl+[` belong to Vim while a composer has focus.
Other host shortcuts keep their behavior, except Vim's `Ctrl+R`, Insert-mode `Ctrl+W`, and Normal/Visual-mode `Alt+/`.
Native multi-key shortcuts keep their pending keys until they finish or cancel.
Enter keeps the host submit behavior, unless a pending command consumes it, as in `r` followed by Enter.
In Normal mode, `/` enters Insert mode and inserts `/` without discarding the draft.
Use `Alt+/` for forward search.
Tab keeps its host behavior; this version does not switch focus to a Vim transcript.
In Normal mode, uncounted Down reaches later handlers on the last display row when no operator is pending.

Search is literal, case-sensitive, and wraps.
It does not use regular expressions.
A search answer does not apply after the draft changes.

Registers belong to the plugin instance and are shared by composers.
Named registers support uppercase append.
The plugin also supports the unnamed register, yank register `0`, delete registers `1` through `9`, small-delete register `-`, and black-hole register `_`.
Yanks copy the selected text through `tui.copy`, unless the target is the black-hole register.
Deletes and changes do not write the system clipboard.
`p` and `P` read Vim registers, not the desktop clipboard.

History, marks, and dot repeat belong to each composer.
A draft reset clears them.
Undo restores the text and its image and paste span metadata.
Dot repeat does not recreate image attachments.
History retains at most 100 groups and about one million UTF-16 units, plus an oversized newest group.

New line insertions and linewise puts use LF.
Motions and deletion keep existing CRLF pairs whole.
Indentation uses two spaces and a tab width of two cells.
Normal-mode terminal paste is not supported; enter Insert mode first.
Ordinary fields, dialogs, and transcript widgets keep their native behavior.

## Transcript core requirement

The old transcript mode remains blocked on a core source mapping error.
One confirmed case concerns clipped tool titles:

1. A rendered title represents its shortened subject as one `replacement` source mapping.
2. `rows.at` maps a character inside that title to a source endpoint.
3. A caret set to that position appears at the endpoint, not at the chosen character.

The core must map visible title characters to usable caret positions and preserve their anchors across document updates.
The core renderer can map the visible prefix as `text` and the ellipsis as `replacement`.
This focused correction comes before any proposal for a new public operation.
The fix must cover clipped titles, folds, and reflow.
The plugin must not inspect renderer caches or construct its own copy of the renderer.
Visible-text search, section stops, source yanks, marks, and composer/transcript focus changes remain part of that later port.

This is an editing subset, not a complete Vim implementation.
Replace mode, macros, blockwise Visual mode, Ex commands, global marks, regex search, and desktop clipboard registers are not implemented.

## Checks

From the repository root:

```sh
yuke test plugins/vim/tests
python3 plugins/vim/scripts/parity.py
python3 plugins/vim/tests/terminal.py
```

The first command runs public widget tests through the real Yuke core, scene, and keymap.
The parity script requires an installed Vim executable and compares 587 sequences with its text and caret results.
It uses typed `feedkeys` input so cursor movement splits Insert undo groups correctly.
The terminal script loads the manifest in an isolated profile and checks edits, undo, and profile reload.
Both verification scripts use isolated state and make no model requests.
Set `YUKE_BINARY` to test another Yuke executable.

The generated Unicode word classes come from Vim `v9.2.1046`.
Run `python3 plugins/vim/scripts/unicode.py` to regenerate them from the pinned upstream source.
The generator uses the Python standard library and requires network access.
The Vim license for these tables is in `LICENSE.vim.txt`.
