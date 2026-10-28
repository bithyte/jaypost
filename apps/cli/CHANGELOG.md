# jaypost

## 0.10.0

### Minor Changes

- 6b894a7: `JAYPOST_APPROVERS` holds the voters for direct `request`. `-u` overrides it, set but empty exits 2, and it exits 2 in service mode. Voter ids are masked in GitHub Actions logs. The Action takes `approvers`, `require` and `retry`.
- 4308327: One service can now hold several bots and serve several people, each through their own API key. New admin commands: `jaypost bot add|list|remove`, `key create|list|label|revoke`, `pairing create|list|remove` and `admin-key rotate`, backed by `/admin` routes that take a separate admin key. `jaypost log` takes `--bot`, `--pairing`, `--key` and `--all`, and `GET /log` returns a key's own questions. `GET /status` adds `key`, `pairing`, `state` and `error`. `reset-owner` no longer restarts the service. Existing installs upgrade in place: the bot, owner and API token become `b1`, `p1` and `k1`. Behavior change: a wrong token on an install without a token now gets 401. Not included: TLS (use a reverse proxy), quotas and per-key voter lists. See docs/hosting.md.
- c0836c1: The MCP server has two new tools: `cancel_question` withdraws a background question, and `list_questions` lists the session's background questions whose answers haven't been collected yet.
- bfc6902: The MCP tools `ask_for_permission` and `ask_for_permission_in_background` are now `ask_user` and `ask_user_async`, since they ask any question, not just for permission. Update permission rules and prompts that name the old tools. The MCP server also sends instructions saying when to use each tool, and the Claude Code plugin adds a `jaypost:phone` skill on writing questions and notices for the phone.
- 1c4ec83: Notifications take `deleteAfter` (`delete_after` on `notify_user`, `--delete-after` on `notify`): seconds, or an ISO 8601 timestamp, until the bot deletes it. It isn't shifted by quiet hours and is capped at 47 hours; without it a notification keeps the 8-hour default. `jaypost hook` sends idle-prompt notifications with 300 seconds. Needs a service at least this new; an older one ignores the field. Direct mode can't delete, so it ignores it too.
- 6b894a7: New `jaypost pair approver` pairs approvers and prints their ids. Breaking: `setup-ci` no longer pairs approvers and `--approvers-only` is gone; use `jaypost pair approver`.
- 780b664: Commands now show what they're doing while they wait: `test` and `send request` say when the question was sent and count down to the timeout, and `init`, `update`, `uninstall`, `reset-owner` and `setup-ci` show a checklist with live build output. Script output on stdout is unchanged.
- 3983f48: `jaypost hook` handles `Stop`: when Claude finishes and nobody types for a minute, its last message goes to the phone, and a text reply wakes Claude with it as the next prompt (through Claude Code's `asyncRewake`). `UserPromptSubmit` and `SessionEnd` cancel a question that's still waiting. The plugin turns this on and drops `idle_prompt` from its notifications, since the new message covers the same moment.
- d7f7851: `send`, `hook`, `mcp` and the Node `Client` can reach the service by URL with `JAYPOST_URL` (or `Client`'s `url` option), http or https, with an optional path prefix.
- d7f7851: `request -u`, `--require` and `--retry` work in service mode too, through a new `POST /vote` route and a `retry` field on `POST /request`. The Node `Client` takes `retry` as well, answers with `rounds` when it's set, and has `vote()`.
- 5e3801e: `jaypost send request` and `jaypost send notify` are now `jaypost request` and `jaypost notify`, and `jaypost test` is `jaypost ping`, which sends a plain notification instead of a question with buttons. The old names still work.
- 81cfb3d: The service keeps its bots, pairings, keys, pending requests and question log in one `jaypost.db` next to `config.json`, instead of `registry.json` and the per-bot `state.json` and `audit.jsonl`. The old files aren't read, so rerun `jaypost init` after upgrading; the registry starts empty. The question log keeps 30 days, and `/admin/log` still reads a removed bot's questions until then. Needs Node 24.15 or newer.

### Patch Changes

- 8359108: `init` for systemd and launchd drops a saved owner id the provider can't parse (say, a Discord id left in `config.json` under a Telegram install) and goes on to pairing. Before, it kept the id and the service crash-looped on start.

## 0.9.0

### Minor Changes

- 8e75c11: Claude Code plugin in `claude-plugin/`; `jaypost hook` also handles `SessionStart` with a setup check.
- 04e21b3: Several approvers for direct mode. `jaypost send request` takes `-u ID` once per approver, `--require all|majority` to say how the votes decide, and `--retry N` to ask again after a timeout. A vote exits 0 when approved and 3 when rejected, and `--json` adds the tally. The flags exit 2 outside direct mode. `jaypost setup-ci` can pair the approvers and prints their `-u` flags, and `--approvers-only` pairs more of them later without the owner.

## 0.8.0

### Minor Changes

- 469415d: Direct mode for CI. With `JAYPOST_MODE=direct`, `jaypost send` talks to the chat app itself instead of a running service, using `JAYPOST_PROVIDER`, `JAYPOST_BOT_TOKEN` and `JAYPOST_OWNER_ID`. Direct `send request` exits 3 when the answer is the `-d` value or the timeout fired, so a CI step can gate on it; service mode still exits 0 for any answer. New `jaypost setup-ci` pairs an owner and prints the env vars to store as GitHub secrets. The env var rename it relies on is in the `JAYPOST_` prefix changeset.
- 469415d: Every environment variable jaypost reads now starts with `JAYPOST_`: `JAYPOST_PROVIDER`, `JAYPOST_BOT_TOKEN`, `JAYPOST_OWNER_ID`, `JAYPOST_PORT`, `JAYPOST_HOST`. The old names (`PROVIDER`, `BOT_TOKEN`, `OWNER_ID`, `PORT`, `HOST`) are no longer read, so this breaks existing installs. For Quadlet and Compose, rename `PROVIDER`, `BOT_TOKEN`, `OWNER_ID` and `PORT` in the `.env` file to the `JAYPOST_` names before running `jaypost update`, since the new CLI reads that file (`~/.config/jaypost/quadlet/.env` for Quadlet, `~/.config/jaypost/compose/.env` for Compose; the directory moves if you set `JAYPOST_CONFIG` or `XDG_CONFIG_HOME`). If you set `PORT` or `HOST` for `jaypost start`, `mcp`, `hook` or `send`, rename those too. `jaypost update` refuses to update a Quadlet or Compose install until its `.env` is renamed.
- 40294f4: A GitHub Action: `uses: bithyte/jaypost@v0` runs `send request` or `send notify` in direct mode from the release binary, fails the step on a No or a timeout, and sets the `answer` output. `install.sh` reads `JAYPOST_INSTALL_DIR` and `JAYPOST_NO_INIT`.

### Patch Changes

- 68d2d21: On Discord, a DM of `/start ABCD-EFGH` now pairs the bot, the same as on Telegram. It used to count as a wrong guess.
- 68d2d21: `jaypost test` now prints the answer, the way `jaypost send request` does, instead of the HTTP status and raw body. It no longer goes through `fetch`, so a test left unanswered for the full 300 s doesn't hit fetch's headers timeout.
- da756f9: `jaypost test --port N` sends the test question to that port instead of the installed one.

## 0.7.0

### Minor Changes

- 333dedb: One-line install for the standalone binary: `curl -fsSL https://unpkg.com/jaypost/install.sh | sh` picks the binary for your OS and CPU, checks it against `SHA256SUMS`, puts it in `~/.local/bin` and runs `jaypost init`. The website serves the same script at `https://bithyte.github.io/jaypost/install.sh`.

### Patch Changes

- b299efa: Fixed the standalone binary failing every Telegram call, so `jaypost init` rejected any bot token. Also silenced the `url.parse()` deprecation warning (DEP0169) it printed on the first Telegram request.

## 0.6.0

### Minor Changes

- 8b16b97: Discord is now a second provider next to Telegram. Pick it at `jaypost init`, add the bot to a server with the invite link and DM it the pairing code.
- 7bb692a: Renamed from `telegram-ask` to `jaypost`: the npm package, the command, the `JAYPOST_CONFIG` and `JAYPOST_TOKEN` env vars, the `~/.config/jaypost/` directory, the service, container, volume and LaunchAgent names, the release binaries (`jaypost-<platform>-<arch>.gz`) and the library's error class (`JaypostError`). Nothing else changes. There's no migration: jaypost doesn't read the old config, token or install. Run `telegram-ask uninstall`, then `jaypost init`, and update hook and MCP configs. See "Coming from telegram-ask" in the README.

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
