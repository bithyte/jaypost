# Hosting for several people

One jaypost service can hold several bots and serve several people, each through their own API key. Use it when CI workflows share a bot, or when someone else runs a bot for you. The local install is the same service with one bot and one key.

The pieces:

- A **bot** is one chat app account (a Telegram bot, a Discord bot). A service can hold any number of them, from any provider.
- A **pairing** ties one bot to one person, made once with a pairing code.
- An **API key** points to one pairing, so to one bot and one person. Whatever is sent with it goes to that person on that bot. Several keys can share a pairing, which is how one person gets a key per CI workflow without pairing again.
- The **admin key** manages bots, pairings and keys. It can't ask or notify.

There are no user accounts and no signup; the admin hands out keys.

## Inbox

Your machine keeps an inbox, `~/.config/jaypost/inbox.json` (mode 0600). Each bot in it is an alias for one API key on one service, and `jaypost inbox` lists them. A **remote** is a service you administer from this machine: a name, a url and its admin key, added with `jaypost admin remote add`. `jaypost service install` adds the local service, its first bot and its admin key for you. `jaypost inbox join` adds a bot someone else runs. Commands that talk to a bot use the default bot, or `-b ALIAS`; admin commands use `-s NAME`. Keys never print in `inbox` or `admin remote list`. See [Commands](commands.md).

## A VM or server

Install it like any other service (see [Install](install.md)); `service install` makes bot `b1`, pairing `p1`, key `k1` and the admin key. On a VM you reach from your own machine, add `--exposed`:

```
jaypost service install --exposed
```

The service then listens on all interfaces (0.0.0.0) over plain http, so keys cross the network in the clear. Use it on a LAN, or put your own TLS proxy in front and keep the port off the public internet; jaypost doesn't do TLS. Don't install a service you expose with `--no-token`: a call without a token then acts as key `k1`.

It ends by printing the line to run on your own machine, with the VM's hostname as a best guess (fix it if you reach the service through a proxy url):

```
jaypost admin remote add myvm http://myvm:8787 jpa_...
```

That line holds the admin key. Run it there, and every admin command works from that machine:

```
jaypost admin bot list -s myvm
```

With one remote and no local service, `-s` can be left out. Without `--exposed` the service listens on 127.0.0.1 only, and everything here works from the VM itself, where the CLI finds the local admin key in the inbox. To reach a service without an inbox, set `JAYPOST_URL` and `JAYPOST_ADMIN_KEY`. A lone `JAYPOST_ADMIN_KEY` still wins over the inbox's key for the local service. For containers the install reads the admin key from the data volume (`jaypost admin-key show` runs inside).

Admin changes apply to the running service, no restart needed. State lives in `~/.config/jaypost/service/` next to `config.json` (the data volume for containers): `jaypost.db` (bots, pairings, keys, pending requests and the question log) and `admin-key`. An install from before the db isn't read: run `jaypost service install` again, and it starts with an empty registry (the old json files are ignored).

## Add a bot

```
jaypost admin bot add [--provider NAME] [--label TEXT]
jaypost admin bot list
jaypost admin bot remove b2
```

`admin bot add` asks for the provider's settings (the bot token), checks them and starts the bot at once. Adding credentials another bot already uses is rejected, since two runtimes on one Telegram token fight over updates. If the service is down and runs from this machine's files, `admin bot add` writes the registry and the bot starts with the service; a stopped container has to be started first.

`admin bot list` shows each bot's state, pairings and keys. A bot that fails to start (rejected credentials, a provider error) shows `failed` with the reason, retries with backoff (5 seconds, doubling up to 5 minutes), and the other bots keep serving. A bot that fails fatally while running rejects its open questions with their timeout option. Questions on a bot that isn't `running` get 503.

`admin bot remove` deletes the bot with its pairings and keys, and asks first unless `-y`. Its questions stay readable through `/admin/log` until they're 30 days old.

## Hand out keys

For a new person, make an invite with a new pairing on a bot. It works against a remote:

```
jaypost admin key create --bot b2 --label alice --invite -s myvm
```

It prints a line to send to the person, privately, since it holds their key:

```
jaypost inbox join jpi_eyJ1cmwiOi...
```

They run it, and `inbox join` saves the bot in their inbox and waits for them to send the pairing code to the bot (see [Pairing](pairing.md#joining-someone-elses-bot)). An invite carries the service url and an API key, never the admin key. The key is shown once; the service keeps only a hash, so lose it and you make a new one. Until the person pairs, `GET /status` called with the key shows the code.

For a key that isn't going into an inbox, such as a CI secret or an app using `--external-id`, leave `--invite` off and `create` prints the bare key (`jpk_...`) and the pairing code. `--save` adds the key to your own inbox instead, with `--as` to name it.

For someone already paired, or for a second workflow of the same person, share the pairing. It works right away, with no phone step:

```
jaypost admin key create --same-as k2 --label release-workflow
jaypost admin key create --pairing p3
```

`--label` and `--external-id` are free text that jaypost stores and never reads; an app driving the admin API can use `--external-id` to map keys to its own users. Change them later with `jaypost admin key label k4 --label new-name` (an empty value clears it). `jaypost admin key list` never shows key values.

`jaypost admin key revoke k4` revokes a key and ends its open questions with their timeout option. Its pairing stays. `jaypost admin pairing remove p3` removes a pairing and revokes all its keys; `jaypost admin pairing list` shows the pending codes, and `jaypost admin pairing create --bot b2` makes a pairing with no key, an invite for someone who only approves votes.

A person can have one pairing per bot. If someone already paired on a bot redeems another code on it, the key behind that code points to their existing pairing.

## Share a bot between CI workflows

Create one key per workflow on the same pairing, and store each in that workflow's secrets as `JAYPOST_TOKEN`, with `JAYPOST_URL` set to the service. All of them reach the same person on the same bot, none polls the bot itself, and the log tells them apart by key:

```
jaypost admin key create --same-as k1 --label deploy
jaypost admin key create --same-as k1 --label nightly
jaypost admin log --key k5
```

See [CI](ci.md#through-a-service-by-url) for the workflow side.

## What a key can do

A key can ask, ask in the background, vote, notify, check `/status` and read the log of its own questions (`GET /log`). It can't touch another key's questions: polling or cancelling another key's background question id answers 404, same as an unknown id. A regular key never opens an admin route.

In the chat, `/pending`, `/cancel` and `/history` only cover the questions addressed to the sender. A chat person who isn't paired on that bot gets no answer.

`/vote` goes to the voters you name, or to the key's own person if you name none. Each voter must have started a chat with that bot. There are no per-key voter lists.

## Logs

Every logged question records its key, pairing and bot. A key holder reads its own with `GET /log`. The admin reads all of them:

```
jaypost admin log
jaypost admin log --bot b2 --since 7d
jaypost admin log --pairing p3
jaypost admin log --key k5 --json
```

`admin log` goes through `/admin/log`, so it needs the admin key; plain `jaypost log` reads `GET /log`, the entries of the key it holds. A script that needs other keys' entries has to have the admin key. The `pairing` and `key` filters accept ids that no longer exist, so the history of a revoked key or removed pairing stays readable. See [Question log](question-log.md).

## Rotate the admin key

```
jaypost admin rotate-key
```

The old key stops working immediately, the new one is printed once and saved in your inbox (against a remote, add `-s NAME`). If a script or app holds the old one, update it first or it's locked out until you set the new one.

## Reset a person

`jaypost pair reset-owner` resets the pairing of the install's key (`p1` after an upgrade) through `POST /admin/pairings/:id/reset`. The person is forgotten, the pairing gets a fresh code and its keys keep working once someone pairs again. The keys' open questions end with their timeout option. It also removes the owner from the install's inputs, so a restart can't pair them again: the `owner` in `config.json` for systemd and launchd, the owner line in `.env` for containers. A container whose old service saved the owner into `/data/config.json` keeps it there until you run `jaypost owner clear` inside the container or edit the file.

## What isn't built

- No TLS. Use a reverse proxy; `--exposed` is plain http.
- No quotas or rate limits per key.
- No per-key voter lists; `/vote` uses the rule above for every key.
- No user accounts, signup or web UI; only the admin adds bots, and an app on top of the admin API can add the rest.
- Direct mode, `pair ci` and the GitHub Action are unchanged; they don't use any of this.
