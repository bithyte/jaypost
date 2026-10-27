# Hosting for several people

One jaypost service can hold several bots and serve several people, each through their own API key. Use it when CI workflows share a bot, or when someone else runs a bot for you. The local install is the same service with one bot and one key.

The pieces:

- A **bot** is one chat app account (a Telegram bot, a Discord bot). A service can hold any number of them, from any provider.
- A **pairing** ties one bot to one person, made once with a pairing code.
- An **API key** points to one pairing, so to one bot and one person. Whatever is sent with it goes to that person on that bot. Several keys can share a pairing, which is how one person gets a key per CI workflow without pairing again.
- The **admin key** manages bots, pairings and keys. It can't ask or notify.

There are no user accounts and no signup; the admin hands out keys.

## Run it on a VM

Install it like any other service (see [Install](install.md)); `init` makes bot `b1`, pairing `p1`, key `k1` and the admin key. The service listens on 127.0.0.1 only. jaypost doesn't do TLS, so to reach it from other machines put a reverse proxy that terminates TLS in front of it and forward to the port. Set `JAYPOST_HOST` only if the proxy runs somewhere that can't reach loopback, and keep the port off the public internet. Don't install a service you expose with `--no-token`: a call without a token then acts as key `k1`.

Everything below works from the VM itself. From another machine, point the CLI at the proxy:

```
export JAYPOST_URL=https://jaypost.example.com
export JAYPOST_ADMIN_KEY=jpa_...
```

On the VM the CLI finds the admin key on its own: in `~/.config/jaypost/admin-key` (mode 0600) for systemd and launchd, and inside the data volume for containers (it runs `jaypost admin-key show` there). `JAYPOST_ADMIN_KEY` wins when it's set.

Admin changes apply to the running service, no restart needed. State lives next to `config.json` (the data volume for containers): `jaypost.db` (bots, pairings, keys, pending requests and the question log) and `admin-key`. An install from before the db isn't read: run `jaypost init` again, and it starts with an empty registry (the old json files are ignored).

## Add a bot

```
jaypost bot add [--provider NAME] [--label TEXT]
jaypost bot list
jaypost bot remove b2
```

`bot add` asks for the provider's settings (the bot token), checks them and starts the bot at once. Adding credentials another bot already uses is rejected, since two runtimes on one Telegram token fight over updates. If the service is down and runs from this machine's files, `bot add` writes the registry and the bot starts with the service; a stopped container has to be started first.

`bot list` shows each bot's state, pairings and keys. A bot that fails to start (rejected credentials, a provider error) shows `failed` with the reason, retries with backoff (5 seconds, doubling up to 5 minutes), and the other bots keep serving. A bot that fails fatally while running rejects its open questions with their timeout option. Questions on a bot that isn't `running` get 503.

`bot remove` deletes the bot with its pairings and keys, and asks first unless `-y`. Its questions stay readable through `/admin/log` until they're 30 days old.

## Hand out keys

For a new person, make a key with a new pairing on a bot:

```
jaypost key create --bot b2 --label alice
```

It prints the key (`jpk_...`) once and a pairing code. The service keeps only a hash, so lose the key and you make a new one. The key works once the person sends the code to the bot (see [Pairing](pairing.md)); until then `GET /status` called with the key shows the code, so the key holder can find it.

For someone already paired, or for a second workflow of the same person, share the pairing. It works right away, with no phone step:

```
jaypost key create --same-as k2 --label release-workflow
jaypost key create --pairing p3
```

`--label` and `--external-id` are free text that jaypost stores and never reads; an app driving the admin API can use `--external-id` to map keys to its own users. Change them later with `jaypost key label k4 --label new-name` (an empty value clears it). `jaypost key list` never shows key values.

`jaypost key revoke k4` revokes a key and ends its open questions with their timeout option. Its pairing stays. `jaypost pairing remove p3` removes a pairing and revokes all its keys; `jaypost pairing list` shows the pending codes, and `jaypost pairing create --bot b2` makes a pairing with no key, an invite for someone who only approves votes.

A person can have one pairing per bot. If someone already paired on a bot redeems another code on it, the key behind that code points to their existing pairing.

## Share a bot between CI workflows

Create one key per workflow on the same pairing, and store each in that workflow's secrets as `JAYPOST_TOKEN`, with `JAYPOST_URL` set to the service. All of them reach the same person on the same bot, none polls the bot itself, and the log tells them apart by key:

```
jaypost key create --same-as k1 --label deploy
jaypost key create --same-as k1 --label nightly
jaypost log --key k5
```

See [CI](ci.md#through-a-service-by-url) for the workflow side.

## What a key can do

A key can ask, ask in the background, vote, notify, check `/status` and read the log of its own questions (`GET /log`). It can't touch another key's questions: polling or cancelling another key's background question id answers 404, same as an unknown id. A regular key never opens an admin route.

In the chat, `/pending`, `/cancel` and `/history` only cover the questions addressed to the sender. A chat person who isn't paired on that bot gets no answer.

`/vote` goes to the voters you name, or to the key's own person if you name none. Each voter must have started a chat with that bot. There are no per-key voter lists.

## Logs

Every logged question records its key, pairing and bot. A key holder reads its own with `GET /log`. The admin reads all of them:

```
jaypost log --all
jaypost log --bot b2 --since 7d
jaypost log --pairing p3
jaypost log --key k5 --json
```

`--bot`, `--pairing`, `--key` and `--all` go through `/admin/log`, so they need the admin key. Without one, `log` falls back to `GET /log` (the entries of the key it holds) and says so on stderr. A script that needs other keys' entries has to have the admin key. The `pairing` and `key` filters accept ids that no longer exist, so the history of a revoked key or removed pairing stays readable. See [Question log](question-log.md).

## Rotate the admin key

```
jaypost admin-key rotate
```

The old key stops working immediately, the new one is written to the admin key file and printed once. If a script or app holds the old one, update it first or it's locked out until you set the new one.

## Reset a person

`jaypost reset-owner` resets the pairing of the install's key (`p1` after an upgrade) through `POST /admin/pairings/:id/reset`. The person is forgotten, the pairing gets a fresh code and its keys keep working once someone pairs again. The keys' open questions end with their timeout option. It also removes the owner from the install's inputs, so a restart can't pair them again: the `owner` in `config.json` for systemd and launchd, the owner line in `.env` for containers. A container whose old service saved the owner into `/data/config.json` keeps it there until you run `jaypost owner clear` inside the container or edit the file.

## What isn't built

- No TLS. Use a reverse proxy.
- No quotas or rate limits per key.
- No per-key voter lists; `/vote` uses the rule above for every key.
- No user accounts, signup or web UI; only the admin adds bots, and an app on top of the admin API can add the rest.
- Direct mode, `setup-ci` and the GitHub Action are unchanged; they don't use any of this.
