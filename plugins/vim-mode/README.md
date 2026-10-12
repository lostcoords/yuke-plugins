# Vim mode

This plugin owns separate composer and read-only transcript command parsers. Both use the same grapheme navigation and text-object code.
It uses the installed Yuke APIs. It does not need a bundled Vim plugin or a runtime dependency.

## Behavior contract

- Every character motion and edit uses a whole grapheme. An emoji sequence, flag, Indic cluster, or combining sequence stays intact. This is an explicit difference from native Vim.
- Word classes follow Vim `v9.2.1046`, with the default `iskeyword=@,48-57,_,192-255`. Empty lines stop `w` and `b`. Unicode punctuation, spaces, CJK, and emoji use Vim's classes. A lone carriage return is punctuation. CRLF is one line ending.
- Composer `j` and `k` move on logical lines, as in Vim. `gj` and `gk` move on display rows. The goal column uses terminal cells.
- Indentation uses `shiftwidth=2`, `tabstop=2`, and spaces. Joins use `nojoinspaces`. Open and changed lines do not inherit indentation.
- Search is literal and case-sensitive. It wraps. It does not use regular expressions. Keyword search (`*` and `#`) can fail on mixed Latin/CJK keywords. This is an accepted limitation.
- Registers belong to the plugin instance. Composers share them with transcript yanks. Composer marks and history belong to each composer. Transcript marks belong to the chat session for this Yuke run. They do not persist on disk.
- A replacement draft clears its marks, history, and repeat command. History holds at most 100 groups and about 1 MiB of text characters. It keeps the newest group even when that group exceeds the budget.
- Undo restores text and composer span metadata. It never calls `Composer.restore()`, which prepends failed-send content rather than replacing a draft.
- A change and its contiguous inserted replacement form one undo group. A cursor move starts another insert group when the next edit occurs. A new edit clears redo. Repeat does not recreate attached images.

Vim supplies the behavior oracle.

## Composer keys

| Group | Keys |
|---|---|
| Modes | `Esc`, `Ctrl+[`, `i`, `a`, `I`, `A`, `o`, `O`, `v`, `V` |
| Character and line motions | `h`, `l`, arrows, `0`, `^`, `$`, `j`, `k`, `gj`, `gk`, `gg`, `G`, `<count>%` |
| Words | `w`, `b`, `e`, `W`, `B`, `E`, `ge`, `gE` |
| Character targets | `f<char>`, `F<char>`, `t<char>`, `T<char>`, `;`, `,` |
| Structural motions | `%`, `{`, `}` |
| Operators | `d`, `c`, `y`, `gu`, `gU`, `g~`, `>`, `<` |
| Whole-line operators | `dd`, `cc`, `yy`, `guu`, `gUU`, `g~~`, `>>`, `<<` |
| Short edits | `x`, `X`, `s`, `S`, `D`, `C`, `Y`, `p`, `P` |
| Replacement, case, and joins | `r<char>`, `~`, `J`, `gJ` |
| Local marks | `ma`–`mz`, `'a`–`'z`, `` `a ``–`` `z `` |
| Search | `Alt+/`, `n`, `N`, `*`, `#`, `g*`, `g#` |
| History | `u`, `Ctrl+R` in Normal mode, `.` |
| Insert registers | `Ctrl+R`, then a register name |
| Insert word deletion | `Ctrl+W` |

Counts before and after an operator multiply. For example, `2d2w` deletes four words. Counts also apply to insertion, replacement, put, undo, redo, and repeat. A count on `.` replaces the stored count. Counts over 10,000 cancel the command.

The parser waits without a timeout. It has separate phases for an operator, a prefix, a text object, a character target, a register, and a mark. An invalid continuation cancels the command. It does not execute its second key as a new command. Escape and focus changes also cancel a pending command. Control-key shortcuts still pass to Yuke.

In Insert mode, `Ctrl+W` removes preceding spaces and the preceding word on the current logical line. For `hola\nchao<caret>`, it leaves `hola\n<caret>`. A separate `Ctrl+W` at line start removes the preceding line break. It does not split a grapheme or CRLF.

`cw` and `cW` use the word end when the cursor starts on text. They keep following whitespace. `dw` keeps the final line break. `r<char>` replaces complete graphemes without entering Insert mode. Replace mode (`R`) is not supported.

### Text objects

Use `i` for the inner range. Use `a` for the surrounding range.

| Objects | Range |
|---|---|
| `w`, `W` | Word or whitespace-separated WORD |
| `"`, `'`, backtick | Quoted text on the current line. Escaped quotes do not close it. |
| `(`, `)`, `b` | Parentheses |
| `[`, `]` | Square brackets |
| `{`, `}`, `B` | Braces |

Examples: `ciw`, `daW`, `ci"`, `yi[`, and `d2i(`. A bracket count selects an enclosing outer pair. `2i"` includes the quotes. It does not select a second quoted string.

### Registers

- `"a`–`"z` select a named register. An uppercase name appends.
- `"0` holds the last unnamed yank.
- `"1`–`"9` hold line and multiline delete history.
- `"-` holds the last unnamed small delete.
- `"_` discards a yank or delete without changing registers.
- `""` selects the unnamed register.

Composer yanks (`y`, `yy`, `Y`, and Visual `y`) copy the selected text to both the system clipboard and the Vim register. Named yanks also copy the selected text, not the accumulated register contents. Transcript yanks use the same native clipboard command. The terminal must allow OSC 52 clipboard writes. OSC 52 has no acknowledgement.

The black-hole register (`"_`) skips the clipboard in both regions. Deletes and changes update only Vim registers. `p` and `P` read only Vim registers. Use your terminal's paste shortcut in Insert mode to paste system clipboard text. The plugin does not read desktop clipboard registers `"+` or `"*`. Clipboard text matches the stored yank text; linewise metadata remains in the Vim register. A linewise yank omits its final line ending from the clipboard text.

### Visual mode

Motions and text objects update the selection. `o` exchanges its ends. `d`, `c`, `y`, `r<char>`, `u`, `U`, `~`, `>`, `<`, `J`, and `gJ` edit it. A count on a visual shift selects shift units rather than lines.

`p` replaces the selection and saves the replaced text. `P` keeps the unnamed register. `gv` restores the last selection. The composer highlights the selection and shows `VISUAL` or `VISUAL LINE`.

Visual put repeat follows the measured native Vim behavior, including its delete-only repeat.

## Transcript

The transcript stays read-only. It supports the composer's navigation, character finds, literal search, text-object selection, local marks, Visual modes, and yanks. Insert and editing commands do not operate on transcript messages.

| Group | Keys |
|---|---|
| Character and row motions | `h`, `l`, arrows, `0`, `^`, `$`, `j`, `k`, `gj`, `gk`, `gg`, `G`, `<count>%` |
| Words | `w`, `b`, `e`, `W`, `B`, `E`, `ge`, `gE` |
| Character targets | `f<char>`, `F<char>`, `t<char>`, `T<char>`, `;`, `,` |
| Structural motions | `%`, `{`, `}` |
| Search | `Alt+/`, `?`, `n`, `N`, `*`, `#`, `g*`, `g#` |
| Selection | `v`, `V`, `o`, `gv`, the same `i`/`a` text objects as the composer |
| Yanks | `y<motion>`, `y<object>`, `yy`, `Y`, Visual `y`, named registers |
| Marks | `ma`–`mz`, `'a`–`'z`, exact jumps with backtick |
| Yuke navigation | `J`, `K` for part stops; `g y` to copy source text |

Transcript `j` and `k` keep the existing rendered-row behavior. Counts before and after `y` multiply. Structural motions and text objects use visible message text, not hidden Markdown syntax. Search crosses message boundaries and wraps. The same mixed Latin/CJK keyword-search limitation applies.

Transcript marks are shared between panes of the same chat. Source marks retain the message ID, part ID, and part-local source offset. Changes in an earlier part do not shift the mark into another part. A changed source prefix, removed part, or hidden source target makes the jump fail without moving the cursor.

Tool and `thought` titles can also hold marks. They use part-header anchors, not source offsets or stored screen row numbers. A header mark survives folding, rewrapping, changes in earlier parts, and changes to the title. An exact jump restores its column, clamped to a whole grapheme in the current title. Apostrophe jumps to the first nonblank column. Group titles retain the first part of their group. Empty separator rows cannot hold marks.

`V` selects complete rendered rows. A linewise yank keeps linewise register metadata for a later composer `p` or `P`. `gv` restores a saved source or header selection when both targets remain available. Escape, invalid continuations, focus changes, mouse input, and paste cancel a pending command. Native window chords still pass to Yuke.

`Tab` switches between the composer and transcript. In Normal mode, `/` enters Insert mode and inserts `/` at the caret. In the transcript, it first focuses the composer. This preserves the command shortcut and the existing draft. `Alt+/` searches the focused region. `?` searches backward. Default Yuke commands and modal dialogs retain their keys. Enter Insert mode before a terminal paste. Normal-mode paste is not supported.

## Architecture and checks

- `composer.js`: the mode and parser FSM, motion execution, edits, history, repeat, and selection painting.
- `text.js`: grapheme navigation, word classes, logical lines, and text objects.
- `registers.js`: the shared register owner.
- `unicode-classes.js`: generated intervals from the pinned Vim release. Run `python3 scripts/unicode.py` to regenerate it.
- `transcript.js`: the read-only FSM, search, and session-local source and header marks.
- `index.js`: owned registrations and transcript cursor, selection, and scrolling adapters.

ASCII word motions do not segment the entire draft. Unicode motion uses one cached segmentation per navigation owner. Ordinary composer drawing has no selection hook. Visual drawing caches its row segments. A contiguous insert stores one edit range rather than one record per typed character.

Run checks from any directory:

```sh
tsc --noEmit -p ~/.config/yuke/jsconfig.json
PYTHONDONTWRITEBYTECODE=1 python3 ~/.config/yuke/plugins/vim-mode/tests/run.py
PYTHONDONTWRITEBYTECODE=1 python3 ~/.config/yuke/plugins/vim-mode/tests/parity.py
PYTHONDONTWRITEBYTECODE=1 python3 ~/.config/yuke/plugins/vim-mode/tests/search.py
PYTHONDONTWRITEBYTECODE=1 python3 ~/.config/yuke/plugins/vim-mode/tests/transcript.py
yuke check
```

The terminal tests use an isolated profile, workspace, and session store. The parity test runs real Vim with typed `feedkeys(..., 'xt')` input and the real Yuke root dispatcher. Typed input matters for undo groups. `normal!` does not split an insert undo group at an arrow key. It compares UTF-16 caret offsets and text. Whole-grapheme exceptions use separate terminal assertions rather than false parity claims.

`tests/measure.py --base <saved-plugin-folder>` alternates profile-loaded input and draw measurements. `--callgrind <folder> --binary <portable-yuke>` also records instruction totals for two iteration windows. Wall times have noise. Retained heap deltas do not prove cumulative allocation counts.

This is an editing subset, not a complete Vim implementation. Replace mode, macros, blockwise visual mode, Ex commands, global marks, regex search, and clipboard registers are not implemented.
