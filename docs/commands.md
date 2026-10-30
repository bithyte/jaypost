# Commands

Commands that talk to a bot pick it from your [contact book](hosting.md#contacts): `-b ALIAS`, else `JAYPOST_BOT`, else env mode, else the book's default bot. Env mode is when `JAYPOST_URL` or `JAYPOST_TOKEN` is set (and neither `-b` nor `JAYPOST_BOT` is): the book isn't read at all, the url comes from `JAYPOST_URL` (a base URL, `http` or `https`, whose path goes in front of every API path, such as `https://jaypost.example.com/team`; without it the local `JAYPOST_HOST` and `JAYPOST_PORT` apply, default 127.0.0.1:8787) and the key from `JAYPOST_TOKEN`. A book key is never sent to an env URL, and an env token is never sent to a book URL. There is no `--port` on these commands; the book entry carries the port.

## Setup

### `jaypost service install`

```
jaypost service install [launchd|systemd|compose|quadlet] [--exposed] [--port N] [--provider NAME] [--token|--no-token]
```

Installs or replaces the service on this machine and waits for pairing. The target picks where it runs; without one it asks. `--provider` is `telegram` (default) or `discord`, `--port` defaults to 8787, and `--token`/`--no-token` answer the API token question up front. It saves the service and its bot in the contact book. `--exposed` listens on all interfaces over plain http instead of only this machine, and ends by printing the `jaypost admin remote add` line to run on your own machine; see [Hosting](hosting.md#a-vm-or-server). See [Install](install.md).

### `jaypost service uninstall`

```
jaypost service uninstall
```

Stops and removes the service, then asks whether to also delete the saved credentials, API token, paired owner and question log. It also drops the service's entries from the contact book.

Answer no to keep them: `config.json` (systemd, launchd) or the target's `.env` and volume stay on disk, and a later `service install` finds them and reuses the bot token, API token and owner without asking. For systemd and launchd, `jaypost.db` (with the question log) stays.

Yes also removes the target's image, volume and files (for systemd and launchd that includes `jaypost.db`). The launchd log file in `~/Library/Logs/jaypost/` is kept even then.

For systemd and launchd the npm package stays; `service uninstall` prints the command to remove it, `npm rm -g jaypost`, or `npm rm -g --prefix ~/.local/share/jaypost/npm jaypost` if `service install` installed it into that prefix.

### `jaypost service start`, `stop` and `run`

```
jaypost service start
jaypost service stop
jaypost service run
```

`start` and `stop` start or stop the installed service through its target. `run` runs the service in the foreground; the installed services use this.

### `jaypost update`

```
jaypost update
```

Moves the install to the latest version, then hands off to the new CLI to finish. A binary install swaps its copy of the binary for the latest release; an npm install runs `npm i -g`; Quadlet and Compose installs rebuild the image and restart the service.

## Contacts

### `jaypost bots`

```
jaypost bots
jaypost bots join INVITE [--as ALIAS]
jaypost bots default ALIAS
jaypost bots rename ALIAS NEW
jaypost bots remove ALIAS [-y]
```

Lists your contacts (alias, service and the default; never keys), sets the default, renames one or removes one. Removing the default asks which contact takes over.

`join` saves a bot from an invite (`jpi_...`) someone sent you and waits for its pairing code if you haven't paired. `--as` names the contact; the default is the bot's name. See [Pairing](pairing.md#joining-someone-elses-bot).

## Pairing

### `jaypost pair ci`

```
jaypost pair ci [--provider NAME]
```

Pairs an owner and prints the env vars for CI. Add approvers with `jaypost pair approver`. See [CI](ci.md). `jaypost setup-ci` still works as the old name.

### `jaypost pair approver`

```
jaypost pair approver [--provider NAME]
```

Pairs approvers for direct mode votes, one code per person, asking `Pair another?` after each. Prints the new ids as a comma list to add to your approvers list and the `JAYPOST_APPROVERS` secret. See [CI](ci.md).

### `jaypost pair reset-owner`

```
jaypost pair reset-owner
```

Resets the pairing of the install's key (through the service, no restart needed), drops the owner from the install's inputs and waits for a new pairing. It only works on this machine's install, so it refuses while `JAYPOST_URL` is set; `JAYPOST_ADMIN_KEY` wins over the install's admin key, as for the admin commands. See [Pairing](pairing.md). `jaypost reset-owner` still works as the old name.

## Asking and notifying

### `jaypost request`

```
jaypost request TEXT [-o OPTION...] [--allow-text] -d DEFAULT [--timeout S] [-u ID...] [--require all|majority] [--retry N] [--project NAME] [--format plain|markdown] [--attach FILE|-] [--attach-name NAME] [--json] [-b ALIAS]
```

Asks a question from the shell and prints the answer. `-o` adds a button, `-d` is the answer on timeout (added as the last button), `--allow-text` also accepts a typed reply. `-u`, `--require` and `--retry` run a vote or re-ask after a timeout; see [Several approvers](ci.md#several-approvers). See [From the shell](scripts.md#from-the-shell). `jaypost send request` still works as the old name.

### `jaypost notify`

```
jaypost notify TEXT [--project NAME] [--format plain|markdown] [--attach FILE|-] [--attach-name NAME] [--delete-after SECONDS|TIMESTAMP] [-b ALIAS]
```

Sends a message that doesn't need an answer. `--delete-after` deletes it after that many seconds, or at that ISO 8601 time with a timezone (default 8 hours; not shifted by quiet hours, capped at 47 hours). Direct mode ignores it. In a terminal it confirms with a "Sent" line on stderr; from a script it prints nothing. See [From the shell](scripts.md#from-the-shell). `jaypost send notify` still works as the old name.

### `jaypost mcp`

```
jaypost mcp [-b ALIAS]
```

Runs an MCP server on stdin/stdout so agents can ask and notify you. See [Agents (MCP)](mcp.md).

### `jaypost hook`

```
jaypost hook [-b ALIAS] [--project NAME] [--timeout S]
```

A Claude Code hook that sends permission prompts to your chat app and takes your reply to a finished turn as the next prompt. `--project` sets the `[name]` line (default: the project folder), `--timeout` is how long to wait for an answer (default 300, or 3600 for a finished turn). See [Claude Code](claude-code.md#hook-manual-setup).

## Checking a bot

### `jaypost status`

```
jaypost status [-b ALIAS]
```

Shows the target, version, port, where the token comes from (never its value), whether the service is running, and pairing state (with the code and instructions if unpaired).

### `jaypost ping`

```
jaypost ping [-b ALIAS]
```

Sends "Ping from jaypost" as a notification. In a terminal it confirms with a "Sent to Telegram" (or Discord) line on stderr; otherwise it prints `Sent. Check your chat app.` `jaypost test` still works as the old name.

### `jaypost log`

```
jaypost log [--since WHEN] [--project NAME] [-n N | --limit N] [--json] [-b ALIAS]
```

Prints the questions the chosen bot's key asked and how they ended. `--since` takes a duration (`7d`) or a date, `--project` filters by name, `-n` limits to the last N, `--json` prints one object per line. For every bot's log, use `jaypost admin log`. See [Question log](question-log.md).

## Admin

These call the admin routes and need the admin key, except `admin remote`, which manages the remotes saved in your contact book. Every other one takes `-s NAME`, a [remote](#jaypost-admin-remote). Without it the target is `JAYPOST_URL` plus `JAYPOST_ADMIN_KEY` when both are set, else the service on this machine, else the only remote; with several remotes and no local service it exits with an error asking for `-s`. A lone `JAYPOST_ADMIN_KEY` still replaces the book's admin key for the local service. Every one but `admin remote` takes `--json`. See [Hosting](hosting.md).

### `jaypost admin bot`

```
jaypost admin bot add [--provider NAME] [--label TEXT]
jaypost admin bot list
jaypost admin bot remove ID [-y]
```

Adds a bot (asks for its settings), lists bots with their state, pairings and keys, or removes one with its pairings and keys.

### `jaypost admin key`

```
jaypost admin key create (--bot ID | --pairing ID | --same-as KEY) [--label TEXT] [--external-id ID] [--save [--as ALIAS] | --invite]
jaypost admin key list [--bot ID] [--pairing ID]
jaypost admin key label ID [--label TEXT] [--external-id ID]
jaypost admin key revoke ID
```

`create` prints the new key once, with a pairing code when `--bot` made a new pairing. `--save` also adds the key to your own contact book (`--as` names it); `--invite` prints a `jaypost bots join` line to send to someone instead of the key, and works on remotes only. They can't be combined. `list` never shows key values. `label` sets the free-form fields; an empty value clears one. `revoke` leaves the pairing alone.

### `jaypost admin pairing`

```
jaypost admin pairing create --bot ID
jaypost admin pairing list [--bot ID]
jaypost admin pairing remove ID [-y]
```

`create` makes a pairing with no key (an approver invite) and prints its code. `remove` revokes the pairing's keys too.

### `jaypost admin remote`

```
jaypost admin remote add NAME URL ADMIN_KEY
jaypost admin remote remove NAME
jaypost admin remote list
```

A remote is a service on another machine that you administer. `add` checks the admin key against the service and saves it, and asks before replacing a remote with the same name. `remove` forgets it; bots from that service stay in your contacts. `list` shows names and urls, never keys. See [Hosting](hosting.md).

### `jaypost admin rotate-key`

```
jaypost admin rotate-key
```

Replaces the admin key; the old one stops working at once. The new one is printed and saved in your contact book.

### `jaypost admin log`

```
jaypost admin log [--since WHEN] [--project NAME] [-n N | --limit N] [--bot ID] [--pairing ID] [--key ID] [--all] [--json]
```

Prints every bot's questions, or the ones of one `--bot`, `--pairing` or `--key`. If the local service doesn't answer, it reads the first bot's log from the files on disk and says so; `--bot` needs the service running. Flags otherwise as for [`log`](#jaypost-log).

## Other

### `jaypost openapi`

```
jaypost openapi [FILE] [--port N]
```

Prints the API's OpenAPI spec, or writes it to `FILE`. It's left out of `jaypost --help`. See [OpenAPI spec](http-api.md#openapi-spec).
