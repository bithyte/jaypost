# Contact book for bots and services

## Why

With the hosted service, one person can reach bots on several services. Today the client knows
only one target: `JAYPOST_URL`, `JAYPOST_TOKEN` (or the `token` file) and `JAYPOST_ADMIN_KEY` (or
the `admin-key` file). Pinging a second bot means setting env vars and knowing the key's value.
The goal is `jaypost ping -b NeveuBot` and nothing else: a name in, the right url and key out, and
the person never sees or pastes a key after it lands in the book.

A plain local install has to stay as simple as it is now. Someone who installs the service and
uses one bot shouldn't need to know the book exists.

## Goals

- One JSON file on the client, the contact book, holding the local service, the remotes this
  machine administers, and every bot it can reach, with all their keys. It replaces the client
  `token` file and the client's use of the `admin-key` file.
- One bot in the book is always the default, used when no bot is named.
- The book fills itself:
  - `jaypost service install` adds the local service (with its admin key) and the seed bot, as
    default.
  - `jaypost remote add` adds a remote with its admin key.
  - `jaypost admin key create --save` adds a key you made for yourself.
  - `jaypost join <invite>` adds a key someone made for you.
- A clear split on disk between the client's files and the local service's files.
- A service can be installed exposed (listening on all interfaces) so it can be a remote.
- The CLI regrouped: `service`, `remote`, `bots`, `admin`.

## Non-goals

- Existing installs. No migration, no detection of the old layout. Old `token`, `admin-key`,
  `config.json`, `install.json` and `jaypost.db` at the top of `~/.config/jaypost` are simply not
  read. jaypost is alpha; people reinstall (same call as the SQLite change).
- Service-side changes beyond the bind address. No new routes. Invites and remote lines are built
  and read entirely by the CLI.
- TLS. `--exposed` listens on all interfaces over plain http; a proxy is still the way to get
  https.
- One-time invites that the service swaps for a key. Safer, but needs a new route. Later, maybe.
- Choosing the bot per MCP tool call. `jaypost mcp -b X` binds the whole MCP server to one bot.
- A live check in `jaypost bots` (it lists the book offline; `jaypost status -b X` is the live
  check).

## Anti-goals

- The book showing keys. `bots` and `remote list` never print them.
- An admin key ever going into an invite.
- Inviting people onto the local service. Invites only go out on remotes.
- The local single-bot setup getting a new step or a new concept to learn.

## Terms

- **Local service**: the service `service install` set up on this machine. At most one.
- **Remote**: a service this machine administers from afar: a short name, a url other people can
  reach, and its admin key. Like a git remote.
- **Bot** (in the book): an alias for one API key on one service. Strictly a key is one bot and
  one person; the book only ever holds the person's own keys, so alias = bot is fine.
- **Invite**: one line carrying a service url and an API key, for someone else's `join`.

## Disk layout

```
~/.config/jaypost/            ($XDG_CONFIG_HOME/jaypost)
  bots.json                   the contact book (client), mode 0600
  service/                    the local service, only if this machine runs one
    config.json
    install.json
    jaypost.db
    admin-key                 the service's own copy, see below
    compose/  quadlet/        container install files
```

- The top folder is the client's. Everything that reaches a bot (CLI, MCP, hook, Node `Client`)
  reads only `bots.json` (plus the env overrides below).
- `service/` belongs to the local service and its installer. The client never reads it to find a
  url or a key. The only crossings are `service install` and `admin rotate-key`, which copy the
  admin key into the book, and `admin log` reading the local db offline (see Commands).
- `JAYPOST_CONFIG` keeps pointing at the service's `config.json`; its default moves to
  `service/config.json`.
- Containers are unchanged inside: `/data` is still the service folder. On the host, the
  compose/quadlet files move under `service/`.
- The service keeps writing its admin key file next to its `config.json` (now in `service/`),
  because the hub writes it and containers read it with `admin-key show`. That's the service's
  file, not the client's. (My call: the client never depends on it, the service's own storage is
  unchanged.)

## The book file

Shape (field names are the builder's call; this is the content):

```json
{
  "version": 1,
  "default": "local",
  "local": { "url": "http://127.0.0.1:8787", "adminKey": "jpa_..." },
  "remotes": [
    { "name": "neveu", "url": "http://203.0.113.7:8787", "adminKey": "jpa_..." }
  ],
  "bots": [
    { "alias": "local", "url": "http://127.0.0.1:8787", "key": "jpk_..." },
    { "alias": "NeveuBot", "url": "http://203.0.113.7:8787", "key": "jpk_..." }
  ]
}
```

- `local` is present only while a local service is installed.
- A remote's `name` is unique, defaults to the url's host (my call).
- A bot points at a service by url (scheme, host, port, optional path prefix). It doesn't need to
  be a remote or local: a bot from `join` lives on a service you don't administer.
- `key` is absent for an open seed (`service install --no-token`).
- `default` names a bot alias. It's set whenever the book has at least one bot.
- Aliases are unique, case-insensitive for lookup.
- Written atomically, mode 0600.

## Resolving the target

For anything that talks to a bot (`ping`, `status`, `request`, `notify`, `log`, `mcp`, `hook`,
Node `Client`):

1. `-b <alias>` (or `Client({ bot })`): that book entry. Unknown alias is an error that lists
   the known ones.
2. `JAYPOST_BOT=<alias>`: same as `-b`. This is how the Claude Code plugin, which runs `hook` and
   `mcp` with no args, picks a non-default bot (my call).
3. Env mode: if `JAYPOST_URL` or `JAYPOST_TOKEN` is set, the book isn't read at all. URL comes
   from `JAYPOST_URL`, else the local default (`JAYPOST_HOST`/`JAYPOST_PORT` still apply, as
   today); token from `JAYPOST_TOKEN`, else none. A book key is never sent to an env URL and an
   env token is never sent to a book URL (my call: no mixing, so a key can't leak to another
   service). This keeps CI and containers working with no book.
4. The book's default bot.
5. Nothing: error saying to run `jaypost service install` or `jaypost join`.

Explicit `url` / `token` / `host` / `port` on `Client` work as today and also skip the book
(same no-mixing rule).

For `admin` commands, the target service:

1. `-s <name>`: that remote. Unknown name lists the known ones.
2. `JAYPOST_URL` + `JAYPOST_ADMIN_KEY` when set (env mode, as above).
3. The local service, if installed.
4. The only remote, if there's exactly one.
5. Otherwise an error asking for `-s` (my call for 3 to 5).

`--port N` on client commands goes away; `-b` replaces it (my call; the book entry carries the
port). `service install --port` stays.

## Commands

```
jaypost service install [target] [--exposed] [--port N] [--provider NAME] [--token|--no-token]
                                              was `init`
jaypost service uninstall                     was `uninstall`
jaypost service start|stop                    start or stop the installed service
jaypost service run                           was `start`: run in the foreground

jaypost remote add NAME URL ADMIN_KEY
jaypost remote remove NAME
jaypost remote list

jaypost join INVITE [--as ALIAS]

jaypost bots                                  list: alias, service host, default marker
jaypost bots default ALIAS
jaypost bots rename ALIAS NEW
jaypost bots remove ALIAS [-y]

jaypost admin bot add|list|remove ...         was `jaypost bot`
jaypost admin key create ... [--save [--as ALIAS] | --invite]
jaypost admin key list|label|revoke ...       was `jaypost key`
jaypost admin pairing create|list|remove      was `jaypost pairing`
jaypost admin rotate-key                      was `jaypost admin-key rotate`; updates the book
jaypost admin log [--bot|--pairing|--key|--all]
  (every admin command takes -s NAME)

jaypost status|ping [-b ALIAS]
jaypost request|notify|log|mcp|hook ... [-b ALIAS]
jaypost reset-owner                           unchanged; works on the local service
jaypost update                                unchanged
```

`setup-ci`, `pair approver`, the GitHub Action and direct mode are untouched. `update`, `status`,
`ping` and `reset-owner` stay top-level (my call). The hidden `admin-key show` stays as it is,
since containers rely on it.

### service install

What `init` does today, plus:

- `--exposed`: the service listens on `0.0.0.0` instead of loopback. For systemd and launchd
  that's the host setting in the service's config; for containers it's the published port
  binding (today `127.0.0.1:PORT`). Prints a warning that traffic is plain http, so keys cross
  the network in the clear; use it on a LAN or behind your own TLS proxy.
- The service's `config.json` (`apiToken`) stays the source of truth for the seed key, so a
  rerun reuses that token whatever happened to the book. Containers and CI jobs holding it as
  `JAYPOST_TOKEN` keep working.
- Writes the book as soon as the service is installed, before waiting for pairing, so an
  interrupted run leaves a usable entry (my call): `local` (loopback url, admin key from the file
  or from `admin-key show` in the container) and the seed bot. The seed bot's alias defaults to
  `local` (my call; the bot's display name isn't known before pairing). If the book has no
  default, the seed bot becomes it. A rerun updates the `local` entries in place.
- With `--exposed`, ends by printing the line to run on the admin's own machine:

  ```
  To manage this service from another machine, run there:

    jaypost remote add <host> http://<host>:8787 jpa_...
  ```

  `<host>` is the machine's hostname, a best guess; the admin fixes it if they reach the service
  through a proxy url. This prints the admin key, same as `admin rotate-key` does today.

### service uninstall

Removes the service as today, then the `local` entry and the bots pointing at its url from the
book. If that removes the default, the next bot becomes default and it says so (my call).

### service start|stop

Starts or stops the installed service through its target: `systemctl --user start|stop` for
systemd and Quadlet, `launchctl` for launchd, `docker compose`/`podman compose` up/down (or
start/stop) for Compose. No install: error. Exact commands per target are the builder's.

### remote add|remove|list

- `remote add NAME URL ADMIN_KEY` checks the admin key against the service (an admin route like
  `GET /admin/bots`) before saving. Rejected key or unreachable service: error, nothing saved.
  Same name: asks before overwriting.
- `remote remove NAME` drops the remote. Bots on that url stay; they don't need the admin key.
- `remote list`: name and url. Never the admin key.

### admin key create

- Default: prints the key like today (CI handouts, apps using `--external-id`). Book untouched.
- `--save [--as ALIAS]`: also saves it to this machine's book as a bot. Alias: `--as`, else the
  bot's label, else its display name, else its id. Becomes default only if the book had no bots.
  Alias collision: asks on a TTY, fails with a hint to use `--as` otherwise.
- `--invite`: prints one line to send to the person instead of the bare key; book untouched.
  Only on a remote: against the local service it fails with a message saying invites need a
  remote. Uses the remote's url from the book.

  ```
  Send this to alice (it holds her key, send it privately):

    jaypost join jpi_eyJ1cmwiOi...
  ```

- `--save` and `--invite` together is a usage error.
- The pairing code prints as today in every mode.

### admin rotate-key

Rotates as today and writes the new admin key into the book entry it targeted (`local` or the
remote). With an env admin key, prints it as today and leaves the book alone.

### admin log and log

Plain `jaypost log` reads the log of the chosen bot's key through `GET /log`. Today, on a local
install, it reads the service's db directly (works with the service down). That direct read
moves to `admin log` against the local service (my call). On a single-bot local install the seed
key's log is the whole log, so plain `log` shows the same entries as before while the service
runs. `admin log` with no filter flag means `--all`.

### Invites

`jpi_` followed by base64url of a small JSON: a format version, the service url and the key.
Never an admin key. The bot's name isn't in it: `join` reads it from `GET /status`.

### join

```
$ jaypost join jpi_eyJ1cmwi...
Added NeveuBot (203.0.113.7) to your contacts, set as default.
Send /start ABCD-EFGH to @NeveuBot, or open https://t.me/NeveuBot?start=ABCDEFGH
Waiting for pairing... paired. Try: jaypost ping
```

- Decodes the invite, calls `GET /status` with the key to check it and get the bot's display
  name and, if unpaired, the pairing code.
- Saves the bot. Alias: `--as`, else the display name. Asks before overwriting an alias already
  in the book.
- Default only if the book had no bots.
- If unpaired, prints the code and link and waits for pairing the way `init` does today. Ctrl-C
  leaves the entry saved; the key works once paired.
- A rejected key (401) or unreachable service: error, nothing saved.

### bots

- `bots` lists alias, service host, and marks the default. Never prints keys.
- `bots remove` of the default with other bots left asks which becomes default (or picks the
  first and says so when `-y` / not a TTY).
- `bots rename` keeps the default pointing at the renamed entry.

## Node client and MCP

- `new Client()` with no options: `JAYPOST_BOT`, else env mode, else the book default.
  `new Client({ bot: 'X' })` reads that entry. `bot` can't be combined with
  `url`/`host`/`port`/`token` (RangeError, like today's `url` + `port` rule).
- `jaypost mcp -b X` and `jaypost hook -b X`: the whole session goes to that bot.
- The token file lookup (`resolveTokenFile`, `~/.config/jaypost/token`) is removed.

## Docs to update

README quick start and "Ask from anywhere", `commands.md`, `hosting.md` (exposed install,
remotes, admin commands, handing out keys with `--invite` + `join`, CI keys stay bare),
`install.md` (layout, `service` commands), `pairing.md`, `scripts.md`, `mcp.md`,
`claude-code.md`, `ci.md`, `security.md` (where keys live, plain http with `--exposed`),
`openapi.yaml` (admin key location), `GLOSSARY.md` (contact book, remote, local service, invite;
the CLI calls book entries "bots" while the glossary's Bot is the chat app account, so the
glossary needs a term for an entry), `install.sh` and the site if they mention `init`.

## Left to the builder

- Book field names, the module it lives in (likely `@jaypost/store` next to config), and its
  schema validation.
- Exact wording of every message.
- Exact start/stop commands per target.
- Whether `-b` gets a long form (`--bot`) and how it coexists with `admin log --bot`.
- Test layout, following the repo's existing style.
