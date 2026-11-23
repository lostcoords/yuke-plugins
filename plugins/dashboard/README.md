# dashboard

A centered start screen in an empty chat pane: the icon, the name, the folder, the model, the version, and a menu of
one-key actions.

## Installation

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins dashboard
```

Run `/reload` while idle.

## Usage

| Key | Action |
| --- | --- |
| `r` | Resume a session |
| `m` | Choose a model |
| `t` | Themes |
| `l` | Sign in |
| `c` | Choose a command |
| `q` | Quit |

The keys work while the pane has no session and the draft is empty: before the first typed key, or in Vim Normal mode.
Press `i` to type a message that starts with a menu key. A click on a row runs its action too.

The menu shows a row only while its command exists. For example, `t` needs the bundled `themes` plugin.

## Add an item from another plugin

The plugin provides the service `dashboard`. Another plugin adds a row with `addItem`, and gets a remover:

```ts
ctx.find("dashboard")?.addItem({ key: "u", label: "Usage", command: "usage:open" });
```

Name `dashboard` in `optionalUses` of `plugin.json`, so your plugin loads without the dashboard too. Declare the type of
the service in your plugin:

```ts
declare module "yuke:plugins" {
  interface Services {
    readonly dashboard: {
      readonly addItem: (item: { readonly key: string; readonly label: string; readonly command: string }) => () => void;
    };
  }
}
```

An added row goes above `c` and `q`. When two rows have one key, the earlier row keeps it.

`optionalUses` and `ctx.find` need a yuke with optional services. On an older yuke, name `dashboard` in `uses`, and read
it with `ctx.get`.

[MIT](../../LICENSE)
