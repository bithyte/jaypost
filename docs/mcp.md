# Agents (MCP)

If you use the [Claude Code plugin](claude-code.md#plugin), it adds this server for you.

`jaypost mcp [--port N]` is a stdio MCP server with four tools that forward to the [HTTP API](http-api.md). `project_name` shows as `[name]` on the first line of the message, so you can tell which agent is asking. The server also sends MCP instructions that say when to use each tool; Claude Code puts them in the system prompt.

`ask_user` asks a question with buttons, a typed reply or both, and waits for the answer or the timeout:

| Param             | Type     | Required            | Notes                                                                                         |
| ----------------- | -------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `project_name`    | string   | yes                 | Max 100 chars.                                                                                |
| `text`            | string   | yes                 | The question.                                                                                 |
| `format`          | string   | no                  | `plain` (default) or `markdown`; see [Formatting](formatting.md).                               |
| `options`         | string[] | unless `allow_text` | Button labels, unique, max 64 chars each. May be empty with `allow_text`.                     |
| `allow_text`      | boolean  | no                  | Let the user type an answer by replying. Default false.                                       |
| `timeout_option`  | string   | yes                 | Answer returned on timeout. One of `options`, or with `allow_text` any answer up to 64 chars. |
| `timeout_seconds` | number   | no                  | Default 300, max 86400 (24 h); longer values are capped.                                      |
| `attachment`      | object   | no                  | A file or text shown as a document above the message; see below.                              |

`attachment` takes exactly one of `path` and `text`, plus an optional `name`. The MCP server reads the file, so relative paths resolve against the directory it started in. Up to 10 MiB, and the service's limit applies; a service that is too old or a provider without attachments gives a tool error. It works the same on `ask_user_async` and `notify_user`.

| Param             | Type   | Required       | Notes                                                                                                                           |
| ----------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `attachment.path` | string | one of the two | File to attach, read by the MCP server. Absolute, or relative to its cwd.                                                       |
| `attachment.text` | string | one of the two | Text to attach, such as a diff you already have in context.                                                                     |
| `attachment.name` | string | no             | File name in Telegram, max 255 chars. Default the path's basename, or `attachment.txt`. Use a real extension (`.diff`, `.log`). |

While a question waits, the server sends MCP progress notifications every 60 seconds. Claude Code aborts a silent stdio tool call after 30 minutes (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`); progress keeps it alive when Claude Code sends a progress token. I haven't verified that it does. If it doesn't, raise the per-server `timeout` in `.mcp.json` or use `ask_user_async`.

It returns the answer as text (with `(timed out, no answer from the user)` appended on timeout) and as structured content `{ "answer": "...", "timed_out": false }`.

`ask_user_async` takes the same params as `ask_user` but returns as soon as the message is sent, for agents with other work to do first or a client that can't hold a long call. The text result is `Asked. Call wait_for_answer with request_id <id> when you need the answer (expires <time>).` and the structured content is `{ "request_id": "...", "expires_at": "2026-10-20T06:00:00.000Z" }`. `expires_at` is when the timeout fires (the timeout is capped at 24 h). A service older than this release has no background questions, and the tool says it's too old.

`wait_for_answer` collects the answer:

| Param          | Type   | Required | Notes                                                                                     |
| -------------- | ------ | -------- | ----------------------------------------------------------------------------------------- |
| `request_id`   | string | yes      | From `ask_user_async`.                                                  |
| `wait_seconds` | number | no       | Max time to wait. Omit it to wait until the question settles; `0` checks once. Max 86400. |

It returns text plus structured content `{ "state": ..., "answer"?: ..., "timed_out"?: ... }`:

- answered or timed out: the same text as `ask_user`, structured `{ "state": "done", "answer": "Approve", "timed_out": false }`.
- `wait_seconds` ran out first: `still waiting for the user`, structured `{ "state": "pending" }`.
- cancelled: `the question was cancelled`, structured `{ "state": "cancelled" }`. That's a normal result, not a tool error.

An answer stays readable for 24 h after the question settles. After that, or after a service restart, `wait_for_answer` returns an error saying the service doesn't know the request. It sends progress notifications the same way as `ask_user`. Cancelling a `wait_for_answer` call only stops the wait; the question stays open and you can wait again.

Closing the agent session (the MCP server's stdin) cancels the background questions it asked that haven't been answered, and their Telegram messages get the cancelled line. If the MCP server is killed outright, they stay open until their timeout.

`notify_user` sends a message that doesn't need an answer and returns `sent` once Telegram accepts it:

| Param          | Type   | Required | Notes                                                           |
| -------------- | ------ | -------- | --------------------------------------------------------------- |
| `project_name` | string | yes      | Max 100 chars.                                                  |
| `text`         | string | yes      | The message.                                                    |
| `format`       | string | no       | `plain` (default) or `markdown`; see [Formatting](formatting.md). |
| `attachment`   | object | no       | Same as on `ask_user`.                                |

Register it with Claude Code:

```
claude mcp add jaypost -- jaypost mcp
```

In a container or anywhere the package isn't installed, use `npx -y jaypost mcp` as the command. Other clients take the usual JSON:

```json
{
  "mcpServers": {
    "jaypost": { "command": "jaypost", "args": ["mcp"] }
  }
}
```

If the token file isn't readable where the MCP server runs (a container, another user), set `JAYPOST_TOKEN` to its contents, which wins over the file. In a client's JSON, add an `env` block:

```json
{
  "mcpServers": {
    "jaypost": {
      "command": "jaypost",
      "args": ["mcp"],
      "env": {
        "JAYPOST_TOKEN": "<contents of ~/.config/jaypost/token>"
      }
    }
  }
}
```

For a container, `export JAYPOST_TOKEN=$(cat ~/.config/jaypost/token)` and then `-e JAYPOST_TOKEN` (name only) does the same; a `-e NAME=value` would show the token in `ps`.

The port comes from `--port`, then `JAYPOST_PORT`, then the install's `install.json`, then 8787. Set `JAYPOST_URL` to reach a service by URL instead, on another host or behind a reverse proxy; `--port` still wins over it. If you run `start` by hand on a custom port without an install, pass `--port` or set `JAYPOST_PORT`.

The service has to be running. A call made while it's down returns an error to the agent; the MCP server stays up, so the next call works once the service is back.

`project` needs a service at least as new as this release. An older service sends the message without the project line, and `notify_user` reports that the service is too old. Re-run `init` to upgrade. `format` needs a service at least as new as the release that added it; an older one shows the markdown as typed.
