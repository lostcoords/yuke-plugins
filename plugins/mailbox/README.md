# mailbox

Send direct messages between open Yuke sessions on the same machine. Requires macOS or Linux and a shared Yuke profile.

## Installation

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins --folder plugins/mailbox
```

Run `/reload` while idle in each Yuke process.

## Usage

Open two sessions and ask an agent:

> Find the session working on the API. Send it the migration result and ask about compatibility issues.

- `mailbox_list_agents` discovers other open sessions.
- `mailbox_send_message` sends a message or reply.

Keep both sessions open. Messages arrive as notifications. A successful send means queued, not read or completed. Each session keeps its own conversation.

[MIT](../../LICENSE)
