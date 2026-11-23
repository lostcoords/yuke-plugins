# questions

Let the agent ask you questions without waiting. It goes on with the other work, and you answer when you have time.

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins questions
```

Run `/reload` while idle.

## Usage

The agent calls the tool `ask_user` with one to four questions. The call returns at once, so the turn goes on.

- The status bar shows `Questions 2` while two requests of the focused session wait.
- Run `/questions` to answer the oldest request in the question view of Yuke. You can choose options or type an
  answer of your own.
- The answers go to the agent as a notification. An idle agent starts a turn with them.
- Press **Esc** to answer later. The request stays in the queue.

The queue lives in memory. A request that waits when the session closes or Yuke quits is gone.

[MIT](../../LICENSE)
