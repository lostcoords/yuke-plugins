# Yuke plugins

Small, independent plugins for [Yuke](https://github.com/lostcoords/yuke).

## Plugins

| Plugin | Description |
| --- | --- |
| [btw](plugins/btw) | Parallel side questions without changing the main conversation. |
| [mailbox](plugins/mailbox) | Direct messages between open Yuke sessions on the same machine. |
| [subagents](plugins/subagents) | New agents with their own context that report to the agent. |
| [titles](plugins/titles) | Short session titles with a model picker and optional fallbacks. |

## UI plugins

| Plugin | Description |
| --- | --- |
| [vim](plugins/vim) | Vim composer editing through public text widget APIs. |

## Installation

Requires Yuke with the plugin manager. Name the plugins that you want:

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins btw mailbox subagents
```

Or run `/plugins` in Yuke, press `a`, paste the URL of this repository, and select a plugin.

Run `/reload` while idle. Use `/plugins` to manage and update installed plugins.

## License

[MIT](LICENSE)
