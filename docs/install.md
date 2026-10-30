# Install

Create a bot first and have the token ready: with [@BotFather](https://t.me/BotFather) on Telegram, or as in [Discord setup](pairing.md#discord-setup). `jaypost service install`:

1. Detects which targets work here (Podman Quadlet, Docker Compose, systemd, launchd on macOS) and asks where the bot should run. The first usable one in that order is the default (launchd is first on macOS). Or pass it: `service install quadlet`, `service install compose`, `service install systemd`, `service install launchd`. `--provider NAME` picks the chat app; `telegram` (the default) or `discord`.
2. Asks for the bot token (input hidden) and checks it with the chat app. Port is 8787; use `--port N` to change it. It refuses a port that's already in use.
3. Makes an API token. It asks first if you're upgrading an install that has none; `--token` and `--no-token` skip the question. It reuses the install's saved token.
4. Installs and starts the service, and saves it and its bot in your inbox (`~/.config/jaypost/inbox.json`, mode 0600). The bot becomes the default if the inbox has none.
5. Waits for pairing.

`--exposed` makes the service listen on all interfaces over plain http instead of only this machine, and prints the `jaypost admin remote add` line to run on your own machine; see [Hosting](hosting.md#a-vm-or-server).

If it finds an existing install it offers to replace it, reusing the saved bot token and owner (no re-pairing). If there's no install but a bot token was kept by `service uninstall`, it reuses that (and the owner) too. If `service install` fails partway, run it again; the old install record and saved bot token are kept until the new install succeeds.

Node 24.15+ is needed for `npx` and the systemd and launchd targets unless you use the standalone binary; the container targets bring their own Node.

## Standalone binary

Each GitHub Release has a single-file binary for Linux and macOS (x64 and arm64), so you can skip Node:

```
curl -fsSL https://unpkg.com/jaypost/install.sh | sh
```

The same script is on the website too:

```
curl -fsSL https://bithyte.github.io/jaypost/install.sh | sh
```

It picks the binary for your OS and CPU, checks it against the release's `SHA256SUMS`, puts it in `~/.local/bin/jaypost` and runs `jaypost service install`. Right after a release the binaries can take a few minutes to upload; the script says so if it gets there first.

To do it by hand, download `jaypost-<linux|darwin>-<x64|arm64>.gz` from the [latest release](https://github.com/bithyte/jaypost/releases/latest), then:

```
gunzip jaypost-linux-x64.gz && mv jaypost-linux-x64 jaypost && chmod +x jaypost && ./jaypost service install
```

If you downloaded the binary with a browser instead of curl, macOS may block it; run `xattr -d com.apple.quarantine jaypost` first.

`service install` copies the binary to `~/.local/bin/jaypost` and runs the service from there.

Two things live under `~/.config/jaypost/` (or `$XDG_CONFIG_HOME/jaypost/`). `inbox.json` is the client's inbox (mode 0600): every command that talks to a bot reads it, and nothing else there. `service/` belongs to the local service and its installer: `config.json`, `install.json`, `jaypost.db`, `admin-key`, and the `compose/` and `quadlet/` folders below. `install.json` records which target is installed, its port and version; it's what `status`, `pair reset-owner` and `service uninstall` read. The service's own copy of the API token goes in the target's `.env` or in `config.json` as listed below.

## Podman Quadlet

Needs Podman 4.4 or newer and a systemd user session. Written:

- `~/.config/jaypost/service/quadlet/` with a `Dockerfile`, `.env` (bot token, port, owner, `JAYPOST_TOKEN`) and a `.dockerignore` that keeps `.env` out of the image build
- `~/.config/containers/systemd/jaypost.container`
- image `localhost/jaypost:<version>`, volume `jaypost-data` (holds the pairing state and `jaypost.db`)

Runs as a user service named `jaypost`. `service install` enables linger (`loginctl enable-linger`) if needed so it survives logout; it tells you if that needs a password. Logs:

```
journalctl --user -u jaypost -f
```

## Docker Compose

Needs Docker with the compose v2 plugin, and your user in the `docker` group (otherwise `service install` reports it can't talk to docker and skips this target). Written:

- `~/.config/jaypost/service/compose/` with `Dockerfile`, `compose.yaml`, `.env` (bot token, port, owner, `JAYPOST_TOKEN`) and `.dockerignore`
- a named volume `data` in the `jaypost` compose project (holds the pairing state and `jaypost.db`)

Logs:

```
docker compose -f ~/.config/jaypost/service/compose/compose.yaml logs -f
```

This target is untested on real Docker so far.

## systemd (npm)

No container. `service install` installs the package globally with npm (`npm i -g`), or into `~/.local/share/jaypost/npm` if the global prefix isn't writable. If you ran `service install` from an already-installed copy, it uses that. Written:

- `~/.config/jaypost/service/config.json` (bot token, port, owner, `apiToken`)
- `~/.config/jaypost/service/jaypost.db` (bots, keys, pending requests and the question log, written by the service)
- `~/.config/systemd/user/jaypost.service` with absolute paths to `node`, the CLI and the config file (`JAYPOST_CONFIG` is always set in the unit, and `install.json` records the same path)

Logs: `journalctl --user -u jaypost -f`. Linger is handled as for Quadlet.

With the [standalone binary](#standalone-binary) there's no npm package; the unit runs `~/.local/bin/jaypost service run`, and `service uninstall` with a purge deletes that copy.

## launchd (macOS)

A per-user LaunchAgent, no container. With the [standalone binary](#standalone-binary), `service install` copies it to `~/.local/bin/jaypost` and the agent runs that; otherwise it installs the package with npm as the systemd target does and runs `node` with the CLI. Written:

- `~/.config/jaypost/service/config.json` (bot token, port, owner, `apiToken`) and `jaypost.db`, as for systemd
- `~/Library/LaunchAgents/io.github.bithyte.jaypost.plist` with absolute paths to the command and the config file (`JAYPOST_CONFIG` is always set in the plist, and `install.json` records the same path)

The agent runs only while you're logged in to the Mac, and launchd restarts it if it exits with a failure. `service install` needs a desktop session, so it won't offer launchd over SSH with nobody logged in. `jaypost service stop` unloads the agent, but it comes back at your next login (it has `RunAtLoad`) until you run `service uninstall`.

Logs: `tail -f ~/Library/Logs/jaypost/jaypost.log`. They aren't rotated.

`service install` clears the quarantine attribute on the copied binary, so Gatekeeper shouldn't stop it.

## Config

Config is read from `$JAYPOST_CONFIG`, else `$XDG_CONFIG_HOME/jaypost/service/config.json`, else `~/.config/jaypost/service/config.json`. The env vars `JAYPOST_PROVIDER`, `JAYPOST_BOT_TOKEN`, `JAYPOST_OWNER_ID`, `JAYPOST_PORT`, `JAYPOST_HOST` and `JAYPOST_TOKEN` override the file. `apiToken` in the file (or `JAYPOST_TOKEN`) is the token the service requires; without either, the API is open. Clients read `JAYPOST_TOKEN` too; without it they use the key in the inbox. `JAYPOST_PROVIDER` picks the chat app and defaults to `telegram`, and `discord` is the other. `JAYPOST_HOST` defaults to `127.0.0.1` (the container targets set `0.0.0.0` inside the container and publish only on `127.0.0.1`).

The service keeps its bots, contacts and API keys in `jaypost.db` next to the config file (the data volume for containers), along with pending requests and the question log. The env vars and `config.json` only seed the first bot, contact and key when the registry is empty; after that, change things with `jaypost admin bot`, `admin bot contact` and `admin bot key` (see [Hosting](hosting.md)). Running `service install` again with a new bot token or settings re-seeds the first bot; the same values change nothing.

## One instance per token

Only one instance can run per bot token; on Telegram two would fight over the updates. Discord doesn't stop two services sharing a token, and both get every tap, so run only one. `service install` replaces an existing install rather than adding a second. Stop anything you started by hand, including a `docker run` container, before running it.

## Upgrading from the old setup

Earlier versions used `npm run onboard` and `deploy/install-service.sh`. `service install` recognizes that systemd unit as a legacy install, offers to replace it, and reuses the bot token and owner from the existing config. Stop any hand-run Docker container using the same bot token first. The old config file is kept and reused if you pick the systemd target.

Re-running `service install` on an install without an API token asks whether to add one (default yes). Once it's on, curl, n8n and container callers get a 401 until they send `authorization: Bearer <token>`; the CLI, `mcp` and the Node client pick it up on their own from the inbox.

## Upgrading to the inbox

The CLI regrouped its commands and keeps the client's keys in an inbox. `init`, `uninstall` and `start` are now `service install`, `service uninstall` and `service run`; `key`, `bot` and `pairing` moved under `admin` (now `admin bot`, `admin bot contact` and `admin bot key`), and `admin-key rotate` is `admin rotate-key`. See [Commands](commands.md).

There is no migration. The old files at the top of `~/.config/jaypost/` (`config.json`, `install.json`, `jaypost.db`, `admin-key`, `token`, `compose/`, `quadlet/`) are no longer read, so an existing install has to run `jaypost service install` again; it makes a fresh registry and a new `inbox.json`. `jaypost service update` doesn't write the inbox. A service whose unit or plist still runs the old `start` command doesn't work with the new CLI; `service update` or `service install` rewrites the unit. An older CLI's `jaypost update` gets the new CLI onto the machine but can't finish, so run `jaypost service update` after it.

A container install from before this release isn't detected by `service install`; stop or remove the old container first, or the new install fails with "Port 8787 is in use".

## Coming from telegram-ask

jaypost is the new name of `telegram-ask`. It doesn't read the old config, token or install, so set it up fresh:

1. Remove the old service with `telegram-ask uninstall`. Both default to port 8787, so jaypost can't start while the old one runs.
2. Run `jaypost service install`. You can give it the same Telegram bot token, then pair again.
3. Change `telegram-ask` to `jaypost` in your Claude Code hook and MCP configs.
4. Clients now read `JAYPOST_TOKEN`, or the inbox at `~/.config/jaypost/inbox.json`. Update scripts and containers that pass `TELEGRAM_ASK_TOKEN`.
