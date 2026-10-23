# Commands

Commands that talk to the service pick its port from `--port`, then `JAYPOST_PORT`, then the install's `install.json`, then 8787.

## Setup

### `jaypost init`

```
jaypost init [launchd|systemd|compose|quadlet] [--port N] [--provider NAME] [--token|--no-token]
```

Installs or replaces the service and waits for pairing. The target picks where it runs; without one it asks. `--provider` is `telegram` (default) or `discord`, `--port` defaults to 8787, and `--token`/`--no-token` answer the API token question up front. See [Install](install.md).

### `jaypost status`

```
jaypost status
```

Shows the target, version, port, where the token comes from (never its value), whether the service is running, and pairing state (with the code and instructions if unpaired).

### `jaypost test`

```
jaypost test [--port N]
```

Sends "This is a test" with Approve/Decline buttons (Decline on timeout) and prints the response.

### `jaypost reset-owner`

```
jaypost reset-owner
```

Clears the paired owner, restarts the service and waits for a new pairing. See [Pairing](pairing.md).

### `jaypost update`

```
jaypost update
```

Moves the install to the latest version, then hands off to the new CLI to finish. A binary install swaps its copy of the binary for the latest release; an npm install runs `npm i -g`; Quadlet and Compose installs rebuild the image and restart the service.

### `jaypost uninstall`

```
jaypost uninstall
```

Stops and removes the service, then asks whether to also delete the saved credentials, API token, paired owner and question log.

Answer no to keep them: `config.json` (systemd, launchd) or the target's `.env` and volume stay on disk, and a later `init` finds them and reuses the bot token and owner without asking. For systemd and launchd, `state.json` and the question log stay. The API token file `~/.config/jaypost/token` is kept too, and the next `init` reuses it.

Yes also removes the target's image, volume and files (for systemd and launchd that includes `state.json` and `audit.jsonl`). The launchd log file in `~/Library/Logs/jaypost/` is kept even then.

For systemd and launchd the npm package stays; `uninstall` prints the command to remove it, `npm rm -g jaypost`, or `npm rm -g --prefix ~/.local/share/jaypost/npm jaypost` if `init` installed it into that prefix.

## Asking and notifying

### `jaypost send request`

```
jaypost send request TEXT [-o OPTION...] [--allow-text] -d DEFAULT [--timeout S] [-u ID...] [--require all|majority] [--retry N] [--project NAME] [--format plain|markdown] [--attach FILE|-] [--attach-name NAME] [--json] [--port N]
```

Asks a question from the shell and prints the answer. `-o` adds a button, `-d` is the answer on timeout (added as the last button), `--allow-text` also accepts a typed reply. `-u`, `--require` and `--retry` only work in [direct mode](ci.md). See [From the shell](scripts.md#from-the-shell).

### `jaypost send notify`

```
jaypost send notify TEXT [--project NAME] [--format plain|markdown] [--attach FILE|-] [--attach-name NAME] [--port N]
```

Sends a message that doesn't need an answer. See [From the shell](scripts.md#from-the-shell).

### `jaypost mcp`

```
jaypost mcp [--port N]
```

Runs an MCP server on stdin/stdout so agents can ask and notify you. See [Agents (MCP)](mcp.md).

### `jaypost hook`

```
jaypost hook [--port N] [--project NAME] [--timeout S]
```

A Claude Code hook that sends permission prompts to your chat app. `--project` sets the `[name]` line (default: the project folder), `--timeout` is how long to wait for a tap (default 300). See [Claude Code](claude-code.md#hook-manual-setup).

### `jaypost log`

```
jaypost log [--since WHEN] [--project NAME] [-n N | --limit N] [--json]
```

Prints the questions the service asked and how they ended. `--since` takes a duration (`7d`) or a date, `--project` filters by name, `-n` limits to the last N, `--json` prints one object per line. See [Question log](question-log.md).

## CI

### `jaypost setup-ci`

```
jaypost setup-ci [--provider NAME]
```

Pairs an owner and prints the env vars for CI. Add approvers with `jaypost pair approver`. See [CI](ci.md).

### `jaypost pair approver`

```
jaypost pair approver [--provider NAME]
```

Pairs approvers for direct mode votes, one code per person, asking `Pair another?` after each. Prints the new ids as a comma list to add to your approvers list and the `JAYPOST_APPROVERS` secret. See [CI](ci.md).

## Other

### `jaypost start`

```
jaypost start
```

Runs the service in the foreground. The installed services use this.

### `jaypost openapi`

```
jaypost openapi [FILE] [--port N]
```

Prints the API's OpenAPI spec, or writes it to `FILE`. See [OpenAPI spec](http-api.md#openapi-spec).
