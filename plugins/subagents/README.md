# subagents

Let the agent delegate work to subagents with separate context and receive their reports.

## Installation

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins subagents
```

Run `/reload` while idle.

## Usage

Ask the agent to delegate an independent task, such as a review or research question. It can start subagents, send follow-up instructions, and stop them.

Running subagents appear below the composer:

- **Down** on the composer's last row selects a subagent.
- **Enter** opens its transcript. **Esc** returns to the parent.
- **x** stops the selected subagent.

Use `/subagents:models` to choose models. Quitting or reloading stops running subagents. The end of a run closes the
subagent and stops its background commands, so start a long-lived process, such as a dev server, from the parent. The
report names the jobs that stopped.

[MIT](../../LICENSE)
