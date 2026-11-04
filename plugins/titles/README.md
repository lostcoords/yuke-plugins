# titles

Automatically name new Yuke sessions from their first message.

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/titles
```

## Setup

1. Run `/reload`.
2. Open `titles:settings` in the command palette.
3. Add a small, fast model and choose its reasoning level.

Settings save automatically. No model selected means no automatic titles.

Optional: add more models as fallbacks. The plugin tries them from top to bottom.

Use `titles:regenerate` to generate a new title for the current session.
