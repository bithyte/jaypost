# Agents (MCP)

If you use the [Claude Code plugin](claude-code.md#plugin), it adds this server for you.

`jaypost mcp [-b ALIAS]` is a stdio MCP server with six tools that forward to the [HTTP API](http-api.md). `project_name` shows as `[name]` on the first line of the message, so you can tell which agent is asking. The server also sends MCP instructions that say when to use each tool; Claude Code puts them in the system prompt.

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

`cancel_question` takes a `request_id` and withdraws a background question you no longer need; its message gets the cancelled line. It returns the same text and structured content as `wait_for_answer`: `{ "state": "cancelled" }`, or the answer if the user got there first. An unknown id is a tool error.

`list_questions` takes no params and lists the background questions this MCP server asked that haven't been collected with `wait_for_answer` or cancelled, so an agent that lost a `request_id` (after context compaction, say) can find it again. It doesn't ask the service, so some may already be answered or timed out; call `wait_for_answer` to read them. Questions from other sessions aren't listed. The structured content is `{ "questions": [{ "request_id", "project_name", "text", "expires_at" }] }`, and the text has one line per question, or `no open questions`.

`notify_user` sends a message that doesn't need an answer and returns `sent` once Telegram accepts it:

| Param          | Type   | Required | Notes                                                           |
| -------------- | ------ | -------- | --------------------------------------------------------------- |
| `project_name` | string | yes      | Max 100 chars.                                                  |
| `text`         | string | yes      | The message.                                                    |
| `format`       | string | no       | `plain` (default) or `markdown`; see [Formatting](formatting.md). |
| `attachment`   | object | no       | Same as on `ask_user`.                                |
| `delete_after` | number or string | no | Seconds until the notification is deleted, or an ISO 8601 timestamp with a timezone. Default 8 hours; not shifted by quiet hours, capped at 47 hours. An older service ignores it. |

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

The server talks to your default contact, or the one `-b ALIAS` (or `JAYPOST_BOT`) names. If the contact book isn't readable where the MCP server runs (a container, another user), set `JAYPOST_URL` and `JAYPOST_TOKEN` instead; when either is set the book isn't read. In a client's JSON, add an `env` block:

```json
{
  "mcpServers": {
    "jaypost": {
      "command": "jaypost",
      "args": ["mcp"],
      "env": {
        "JAYPOST_URL": "https://jaypost.example.com",
        "JAYPOST_TOKEN": "<an API key>"
      }
    }
  }
}
```

For a container, `export JAYPOST_TOKEN=<an API key>` and then `-e JAYPOST_TOKEN` (name only) does the same; a `-e NAME=value` would show the token in `ps`. Keys come from `jaypost admin key create` (see [Hosting](hosting.md)) or the `key` of a bot in `~/.config/jaypost/bots.json`.

The bot comes from `-b`, then `JAYPOST_BOT`, then `JAYPOST_URL`/`JAYPOST_TOKEN` (the book isn't read), then the book's default. `JAYPOST_URL` reaches a service by URL, on another host or behind a reverse proxy; without it, env mode uses `JAYPOST_HOST` and `JAYPOST_PORT`, then 127.0.0.1:8787. Add a contact with `jaypost bots join` or `jaypost service install`.

The service has to be running. A call made while it's down returns an error to the agent; the MCP server stays up, so the next call works once the service is back.

`project` needs a service at least as new as this release. An older service sends the message without the project line, and `notify_user` reports that the service is too old. Run `jaypost service install` again to upgrade. `format` needs a service at least as new as the release that added it; an older one shows the markdown as typed.

## Telling the agent when to ask

The tool descriptions and the server's instructions only say what each tool does. Agents still tend to skip `ask_user` before a risky step, or ask in the chat whether they should ask. Paste this into `CLAUDE.md`, `AGENTS.md` or a system prompt, and edit the lists to fit the project:

```markdown
## Reaching me on my phone (jaypost)

I'm often away from the terminal. The jaypost MCP tools are how you reach me: call them directly. Don't ask in chat whether to ask, and don't stop to wait for a chat reply I won't see.

Ask with `ask_user` before you:

- do something destructive or hard to undo: delete files, data or branches, force-push, rewrite history, run migrations
- spend money or touch something shared: deploy, publish a package, call a paid API, message other people
- pick between options that change what gets built, when the code and the task don't settle it

Don't ask about what you can decide from the code or a sensible default. Pick one and mention it when you report back.

Use `notify_user` when no answer is needed: the task is done, you're blocked on something only I can fix, or a long step finished.

Make `timeout_option` the choice that changes nothing.
```

With the [Claude Code plugin](claude-code.md#plugin) or hook, tool permission prompts already reach the phone, so a tool call that needs permission is asked about anyway. The snippet matters for the steps that run without a prompt, and the plugin's `jaypost:phone` skill says the same thing.
