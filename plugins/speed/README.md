# speed

Show the output speed of the model in the status bar, in tokens per second.

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins speed
```

Run `/reload` while idle.

## Usage

The status bar shows the speed of the newest answer in the session of the focused pane.

- `84 tok/s` is a completed answer: the output tokens of the provider over the time from the first block of the
  answer to its end. The wait before the first token does not count. The count includes the tokens of a thought that
  streams, also when it streams no text. Hidden reasoning that streams no block runs before the first block, so its
  tokens do not count.
- `~60 tok/s` is an estimate while an answer streams: the streamed text, at about four characters per token. Hidden
  reasoning streams no text, so the estimate can be low until the answer ends.

An answer below 100 milliseconds shows no speed, because its time is mostly the cost of the request.

[MIT](../../LICENSE)
