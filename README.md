# Yuke plugins

Small, independent plugins for [Yuke](https://github.com/lostcoords/yuke).

## Plugins

| Plugin | Description |
| --- | --- |
| [btw](plugins/btw) | Parallel side questions without changing the main conversation. |
| [subagents](plugins/subagents) | New agents with their own context that report to the agent. |
| [vim](plugins/vim) | Vim composer editing through public text widget APIs. |

## Installation

Requires Yuke with the plugin manager. Install the plugin you want:

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/btw
```

Run `/reload` while idle. Use `/plugins` to manage and update installed plugins.

## Tests

From a checkout of this repository:

```sh
yuke test plugins/btw/tests
yuke test plugins/subagents/tests
yuke test plugins/vim/tests
```

## License

[MIT](LICENSE)
