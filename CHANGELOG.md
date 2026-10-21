# jaypost

## 0.5.0

### Minor Changes

- 1d6bb67: Attachments: `attachment` on `/request`, `/request/async` and `/notify` (and on `ask_for_permission`, `ask_for_permission_in_background` and `notify_user`, `--attach` on `send`, `attachment` on `Client`) sends one file to Telegram as a document right above the message. Needs a service at least this new; clients say so if it isn't.
- 931109b: The service keeps a log of every question and how it ended in `audit.jsonl` next to its config, and `telegram-ask log` prints it (`--since 12h`, `--project`, `-n`, `--json`). Installs from earlier versions need `telegram-ask init` to start logging.
- 86cba2e: Free-text replies: `allowText` on `/request` (and `allow_text` on `ask_for_permission`, `allowText` on `Client`, `--allow-text` on `send request`) lets you answer by replying to the question with text.
- cdf62c0: New `launchd` install target for macOS: `init` installs a per-user LaunchAgent, from the standalone binary or npm, and it's the default there.
- a2bf062: Questions can now wait up to 24 h (`timeout` max 86400, default still 300). Behavior change: a `timeout` above 300, say 900, used to be clamped to 300 and now waits the full time. The Claude Code hook `timeout` setting must be at least `--timeout` + 60.

  New endpoints for callers that can't hold a connection open: `POST /request/async` returns `202` once the message is sent, `GET /request/{id}` reads the state (with `?wait=` to long-poll), and `DELETE /request/{id}` cancels. A restart drops background questions; the next start expires their messages.

  The MCP server has two new tools: `ask_for_permission_in_background` asks and returns a `request_id` at once, and `wait_for_answer` collects the answer (waiting until it settles by default, or `wait_seconds` at most). Closing the agent session cancels the background questions it hasn't seen answered.

- b90e85e: Message formatting. `format: "markdown"` on `/request`, `/notify`, both MCP tools, the Node `Client` and `send --format` renders code spans and fenced blocks, bold, italic, strikethrough, headings and quotes, so a command or diff shows up in monospace. Plain text stays the default and nothing changes for callers who don't send `format`. Unrecognized markup stays as typed, and if Telegram rejects the formatting the message is sent as plain text.
- 835a958: Quiet hours and mute. `/quiet 23:00-08:00` and `/mute 2h` (with `/unmute`) make notifications arrive silently; approvals still ping. A notification sent while quiet is deleted 8 hours after the quiet period ends. `init` now sets `TZ` for container installs so the window uses your local time. Existing container installs stay on UTC until `init` is re-run. When quiet runs past 47h, the notification isn't auto-deleted.
- aa66ab1: `send request` takes `-d, --default <label>` in place of `--timeout-option`, and adds it as the last button unless an `-o` already names it, so `-o Approve -d Decline` is enough. Breaking: scripts using `--timeout-option` need to switch to `-d`.
- c6f7450: Standalone binaries for Linux and macOS on each GitHub Release; `init` can install the binary as a systemd service without Node. New `update` command for binary, npm, Quadlet and Compose installs.

## 0.4.0

### Minor Changes

- 36d4db7: Bot commands: `/pending` lists open requests, `/cancel` rejects them all with their timeout answers, `/history [N]` shows the last settled ones.
- 282afee: Add `telegram-ask hook`, a Claude Code `PermissionRequest` and `Notification` hook that sends permission prompts to Telegram.
- 75e967d: Optional API token. `init` generates one for new setups (and asks when upgrading an install without one); the service then answers 401 without it. The CLI, `mcp` and the Node `Client` send it on their own; curl, n8n and container agents set `TELEGRAM_ASK_TOKEN` to the contents of `~/.config/telegram-ask/token`.
- ffa80a1: Notifications keep their 8-hour auto-delete across restarts, and requests left pending by a restart are edited to an expired line when the service comes back. State lives in `state.json` next to the config.

## 0.3.0

### Minor Changes

- `telegram-ask send request` and `telegram-ask send notify` call the HTTP API from a shell, so scripts don't need curl.
- Use telegram-ask as a Node library: `import { Client } from 'telegram-ask'` gives `request()` and `notify()` over the local service. Failures throw `TelegramAskError`, a timeout resolves with `timedOut: true`, and an `AbortSignal` cancels the question.
- OpenAPI spec for the HTTP API. The service serves it at `GET /openapi.yaml`, `telegram-ask openapi [FILE]` prints or writes it, and a copy lives in `docs/openapi.yaml`.

## 0.2.0

### Minor Changes

- Notifications: `POST /notify` sends a message with a dismiss button. Notifications expire after 8 hours.
- `/request` and `/notify` accept an optional project name, shown above the message.
- `telegram-ask mcp` runs an MCP server on stdio with `ask_for_permission` and `notify_user` tools, so agents like Claude Code can ask and notify you.
- `telegram-ask init --provider NAME` (or the `PROVIDER` env var) picks the chat app. `telegram` is the default and the only one for now.
