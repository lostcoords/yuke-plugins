# subagents

Let the agent start subagents: new agents with their own context that report to it.

## Installation

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/subagents
```

Run `/reload` while idle.

## Usage

Ask for a subagent, or let the agent decide for work that is independent, large, or parallel.

- `spawn_subagent`: start a subagent with a short description and a brief, in the background or in the call.
- `message_subagent`: send a follow-up or a new instruction to a subagent by its id.
- `stop`: stop a subagent by its id.

The id of a subagent is the id of its session, and the id of its job. A client of `yuke --rpc` can load that session.

In the terminal, the running subagents show under the composer. Press Down on the last row of the composer to select one: Enter opens it, x stops it, and Esc leaves the list. An open subagent is read-only, and Esc goes back to its parent.

A subagent uses the session model. To choose others, run `subagents:models`: `a` adds a model and its reasoning level, `d` removes it, Enter makes it the default, and `R` reloads. The agent can then pick from that list with the `model` argument of `spawn_subagent`. The list is in `settings.json` in the data folder of the plugin, so a client of `yuke --rpc` edits that file. A changed list reaches new sessions. It cannot start subagents. Its questions go to the user of its parent.

A crash, a quit, or a reload stops a running subagent. When the parent session opens again, a notice names the subagent, and the agent reads it with the next message. Nothing resumes by itself.

The tools work in the terminal, in `yuke --rpc`, and in `yuke -p`. A background subagent does not run in `yuke -p`.

## Tests

```sh
yuke test plugins/subagents/tests
python3 plugins/subagents/tests/rpc.py
```
