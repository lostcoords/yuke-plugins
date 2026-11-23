# usage

`/usage` shows the token usage and the estimated cost of the saved sessions.

| View | Content |
| --- | --- |
| Overview | The totals of all sessions: input, cache reads, output, reasoning, answers, and the estimated cost. |
| Periods | The totals by day, week, or month of the last activity of each session. `p` changes the period. |
| Models | The totals of each model, the most expensive first. |
| Tools | The calls and the errors of each tool. |
| Chats | The sessions, the most expensive first. `enter` shows a session in the pane. |

`tab` goes to the next view. `f` changes the scope between every folder and the folder of the session in the pane.
`ctrl+r` reads the sessions again. The plugin keeps the usage of each session in memory, and reads again only the
sessions that changed.

The cost uses the prices of the model catalog. An answer counts as unpriced when its model has no price for a token
kind that it used. The plugin reads each session through the session API, so the first open of a large store can take
some seconds.
