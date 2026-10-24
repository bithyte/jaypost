# Install

Create a bot first and have the token ready: with [@BotFather](https://t.me/BotFather) on Telegram, as in [Discord setup](pairing.md#discord-setup), or as in [Slack setup](pairing.md#slack-setup). `init`:

1. Detects which targets work here (Podman Quadlet, Docker Compose, systemd, launchd on macOS) and asks where the bot should run. The first usable one in that order is the default (launchd is first on macOS). Or pass it: `init quadlet`, `init compose`, `init systemd`, `init launchd`. `--provider NAME` picks the chat app; `telegram` (the default), `discord` or `slack`.
2. Asks for the bot token (input hidden; Slack also asks for its app-level token) and checks it with the chat app. Port is 8787; use `--port N` to change it. It refuses a port that's already in use.
3. Makes an API token and saves it to `~/.config/jaypost/token` (mode 0600). It asks first if you're upgrading an install that has none; `--token` and `--no-token` skip the question. It reuses a valid saved token.
4. Installs and starts the service, then waits for pairing.

If it finds an existing install it offers to replace it, reusing the saved bot token and owner (no re-pairing). If there's no install but a bot token was kept by `uninstall`, it reuses that (and the owner) too. If `init` fails partway, run it again; the old install record and saved bot token are kept until the new install succeeds.

Node 24+ is needed for `npx` and the systemd and launchd targets unless you use the standalone binary; the container targets bring their own Node.

## Standalone binary

Each GitHub Release has a single-file binary for Linux and macOS (x64 and arm64), so you can skip Node:

```
curl -fsSL https://unpkg.com/jaypost/install.sh | sh
```

The same script is on the website too:

```
curl -fsSL https://bithyte.github.io/jaypost/install.sh | sh
```

It picks the binary for your OS and CPU, checks it against the release's `SHA256SUMS`, puts it in `~/.local/bin/jaypost` and runs `jaypost init`. Right after a release the binaries can take a few minutes to upload; the script says so if it gets there first.

To do it by hand, download `jaypost-<linux|darwin>-<x64|arm64>.gz` from the [latest release](https://github.com/bithyte/jaypost/releases/latest), then:

```
gunzip jaypost-linux-x64.gz && mv jaypost-linux-x64 jaypost && chmod +x jaypost && ./jaypost init
```

If you downloaded the binary with a browser instead of curl, macOS may block it; run `xattr -d com.apple.quarantine jaypost` first.

`init` copies the binary to `~/.local/bin/jaypost` and runs the service from there.

The API token file `~/.config/jaypost/token` is written for every target; the service's own copy goes in the target's `.env` or in `config.json` as listed below. All targets keep their files under `~/.config/jaypost/` (or `$XDG_CONFIG_HOME/jaypost/`). `install.json` there records which target is installed, its port and version. It's what `status`, `reset-owner` and `uninstall` read.

## Podman Quadlet

Needs Podman 4.4 or newer and a systemd user session. Written:

- `~/.config/jaypost/quadlet/` with a `Dockerfile`, `.env` (bot token, port, owner, `JAYPOST_TOKEN`) and a `.dockerignore` that keeps `.env` out of the image build
- `~/.config/containers/systemd/jaypost.container`
- image `localhost/jaypost:<version>`, volume `jaypost-data` (holds the pairing state and `state.json`)

Runs as a user service named `jaypost`. `init` enables linger (`loginctl enable-linger`) if needed so it survives logout; it tells you if that needs a password. Logs:

```
journalctl --user -u jaypost -f
```

## Docker Compose

Needs Docker with the compose v2 plugin, and your user in the `docker` group (otherwise `init` reports it can't talk to docker and skips this target). Written:

- `~/.config/jaypost/compose/` with `Dockerfile`, `compose.yaml`, `.env` (bot token, port, owner, `JAYPOST_TOKEN`) and `.dockerignore`
- a named volume `data` in the `jaypost` compose project (holds the pairing state and `state.json`)

Logs:

```
docker compose -f ~/.config/jaypost/compose/compose.yaml logs -f
```

This target is untested on real Docker so far.

## systemd (npm)

No container. `init` installs the package globally with npm (`npm i -g`), or into `~/.local/share/jaypost/npm` if the global prefix isn't writable. If you ran `init` from an already-installed copy, it uses that. Written:

- `~/.config/jaypost/config.json` (bot token, port, owner, `apiToken`)
- `~/.config/jaypost/state.json` (pending requests and notification expiries, written by the service)
- `~/.config/systemd/user/jaypost.service` with absolute paths to `node`, the CLI and the config file (`JAYPOST_CONFIG` is always set in the unit, and `install.json` records the same path)

Logs: `journalctl --user -u jaypost -f`. Linger is handled as for Quadlet.

With the [standalone binary](#standalone-binary) there's no npm package; the unit runs `~/.local/bin/jaypost start`, and `uninstall` with a purge deletes that copy.

## launchd (macOS)

A per-user LaunchAgent, no container. With the [standalone binary](#standalone-binary), `init` copies it to `~/.local/bin/jaypost` and the agent runs that; otherwise it installs the package with npm as the systemd target does and runs `node` with the CLI. Written:

- `~/.config/jaypost/config.json` (bot token, port, owner, `apiToken`) and `state.json`, as for systemd
- `~/Library/LaunchAgents/io.github.bithyte.jaypost.plist` with absolute paths to the command and the config file (`JAYPOST_CONFIG` is always set in the plist, and `install.json` records the same path)

The agent runs only while you're logged in to the Mac, and launchd restarts it if it exits with a failure. `init` needs a desktop session, so it won't offer launchd over SSH with nobody logged in.

Logs: `tail -f ~/Library/Logs/jaypost/jaypost.log`. They aren't rotated.

`init` clears the quarantine attribute on the copied binary, so Gatekeeper shouldn't stop it.

## Config

Config is read from `$JAYPOST_CONFIG`, else `$XDG_CONFIG_HOME/jaypost/config.json`, else `~/.config/jaypost/config.json`. The env vars `JAYPOST_PROVIDER`, `JAYPOST_BOT_TOKEN`, `JAYPOST_APP_TOKEN` (Slack only), `JAYPOST_OWNER_ID`, `JAYPOST_PORT`, `JAYPOST_HOST` and `JAYPOST_TOKEN` override the file. `apiToken` in the file (or `JAYPOST_TOKEN`) is the token the service requires; without either, the API is open. The same env var is what clients read, with the token file as their fallback. `JAYPOST_PROVIDER` picks the chat app and defaults to `telegram`, and `discord` and `slack` are the others. `JAYPOST_HOST` defaults to `127.0.0.1` (the container targets set `0.0.0.0` inside the container and publish only on `127.0.0.1`).

## One instance per token

Only one instance can run per bot token; on Telegram two would fight over the updates. Discord doesn't stop two services sharing a token, and both get every tap, so run only one. Slack hands each event to just one of the connected services, so a second one would swallow some of your taps. `init` replaces an existing install rather than adding a second. Stop anything you started by hand, including a `docker run` container, before running `init`.

## Upgrading from the old setup

Earlier versions used `npm run onboard` and `deploy/install-service.sh`. `init` recognizes that systemd unit as a legacy install, offers to replace it, and reuses the bot token and owner from the existing config. Stop any hand-run Docker container using the same bot token first. The old config file is kept and reused if you pick the systemd target.

Re-running `init` on an install without an API token asks whether to add one (default yes). Once it's on, curl, n8n and container callers get a 401 until they send `authorization: Bearer <token>`; the CLI, `mcp` and the Node client pick it up on their own.

## Coming from telegram-ask

jaypost is the new name of `telegram-ask`. It doesn't read the old config, token or install, so set it up fresh:

1. Remove the old service with `telegram-ask uninstall`. Both default to port 8787, so jaypost can't start while the old one runs.
2. Run `jaypost init`. You can give it the same Telegram bot token, then pair again.
3. Change `telegram-ask` to `jaypost` in your Claude Code hook and MCP configs.
4. Clients now read `JAYPOST_TOKEN` and `~/.config/jaypost/token`. Update scripts and containers that pass `TELEGRAM_ASK_TOKEN`.
