# Yuke plugins

Small, independent plugins for [Yuke](https://github.com/lostcoords/yuke).

## Plugins

| Plugin | Description |
| --- | --- |
| [btw](plugins/btw) | Parallel side questions without changing the main conversation. |
| [mailbox](plugins/mailbox) | Direct messages between open Yuke sessions on the same machine. |
| [subagents](plugins/subagents) | New agents with their own context that report to the agent. |
| [titles](plugins/titles) | Short session titles with a model picker and optional fallbacks. |
| [vim](plugins/vim) | Vim composer editing through public text widget APIs. |

## Installation

Requires Yuke with the plugin manager. Run the command for each plugin you want.

```sh
# btw
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/btw

# mailbox
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/mailbox

# subagents
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/subagents

# titles
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/titles

# vim
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/vim
```

Run `/reload` while idle. Use `/plugins` to manage and update installed plugins.

## Tests

From a checkout of this repository:

```sh
yuke test plugins/btw/tests
yuke test plugins/mailbox/tests
yuke test plugins/subagents/tests
yuke test plugins/titles/tests
yuke test plugins/vim/tests
```

## License

[MIT](LICENSE)
