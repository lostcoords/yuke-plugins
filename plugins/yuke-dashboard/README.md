# Yuke dashboard

An empty-session menu for the chat pane. It works without Vim. Click a row, or type a prompt. Assigned letter keys run a row only while the draft is empty.

Without configuration, the rows are sign-in, the model picker, commands, sessions, and quit. Commands stays in the menu even though it has no slash description.

## Install

Use a Yuke build with GitHub plugin-source support. Add this object to the `plugins` array in your profile's `config.json`. Keep the other entries.

```json
{
  "github": "lostcoords/yuke-plugins",
  "ref": "davafons/yuke-dashboard",
  "path": "plugins/yuke-dashboard"
}
```

The branch contains this package until it reaches `main`. Select a published tag or full commit when you need a fixed version. Load only one copy of the dashboard.

Wait for active work to finish. Save your unsent draft before running `/reload`, because reload can discard it.

Yuke caches the resolved commit. A branch does not update automatically. See [Yuke GitHub sources](https://github.com/lostcoords/yuke/blob/main/docs/profile.md#github-sources) for the source-loading contract of a compatible build.

The manifest provides `yuke-dashboard` and lists `composer-vim`, so assigned letters work while Vim is in normal mode. A profile without Vim still loads this dashboard.

## Configure

Configure it from another plugin, the same way a Neovim plugin is configured from Lua. That plugin lists `yuke-dashboard` in `uses`, then calls `setup` or the row methods.

```js
export default function (ctx) {
  const dash = ctx.get("yuke-dashboard");
  dash.setup({
    footer: "unleash your harness",
    rows: [
      { command: "auth:login", label: "Sign in", key: "l" },
      { command: "ui:palette", label: "Commands", key: "c" },
      { command: "quit", key: "q" },
    ],
  });
}
```

`setup` replaces the default rows. `row({ command, label, key })` adds one row. `footer(text)` sets the line under the menu. A `key` is one character. That character runs the row while the draft is empty and does not insert. Any other character starts the prompt.

A missing command is omitted. A key that is not one character omits that row. A repeated key keeps the first row and clears the later key.
