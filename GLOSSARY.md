# jaypost

jaypost lets agents, scripts and CI ask a person a question or notify them on a chat app, and wait for the answer. One service holds several bots and serves several people.

## Language

### Who is reached, and how

**Bot**:
One chat app account (a Telegram bot, a Discord bot) the service runs. On the client, a bot in the inbox is how you reach one: an alias with a service url and an API key.
_Avoid_: Provider (that's the chat app kind), runtime, account

**Person**:
Someone on a chat app who answers questions, identified by their chat app user id.
_Avoid_: User, approver (a role in direct mode), recipient (the wire term)

**Pairing**:
The tie between one bot and one person. Pending until someone sends its pairing code to the bot, then paired. A person has at most one pairing per bot.
_Avoid_: Link, subscription

**Pairing code**:
The one-time code a person sends to a bot to claim a pending pairing.
_Avoid_: Token, invite

**Claim**:
A person sending a pending pairing's code to its bot, which makes the pairing paired.
_Avoid_: Redeem, pair (as a noun)

**Local pairing**:
The one pairing of a bot whose chat app has no people to pair (the terminal), always paired.

### Access

**API key**:
A secret that points to one pairing, so to one bot and one person. Several keys can share a pairing.
_Avoid_: Token (the pre-registry name, kept only for the seed key's `apiToken` and `JAYPOST_TOKEN`)

**Admin key**:
The secret that manages bots, pairings and keys. It can't ask or notify.

**Inbox**:
The client's `inbox.json` in `~/.config/jaypost/` (mode 0600): the bots you reach, the remotes and the local service's entry, with their keys. Each bot in it is an alias for one API key on one service; the CLI lists them under `jaypost inbox` and picks one with `-b`. Every command that talks to a bot reads it unless `JAYPOST_URL` or `JAYPOST_TOKEN` is set.
_Avoid_: Contact book, contact, config, token file, profile

**Local service**:
The service installed on this machine by `jaypost service install`. Its files live in `~/.config/jaypost/service/`.

**Remote**:
A service on another machine that you administer, saved in the inbox with its admin key by `jaypost admin remote add`. Admin commands pick one with `-s`.
_Avoid_: Server, host

**Invite**:
One line, `jaypost inbox join jpi_...`, that carries a service url and an API key (never the admin key) for someone else's `inbox join`. Made with `jaypost admin key create --invite` on a remote.
_Avoid_: Pairing code (that's what a person sends the bot), token

### Storage and the install

**Registry**:
Every bot, pairing and API key of one install.
_Avoid_: Database, config

**Seed**:
Bot 1, pairing 1 and key 1 as `service install` or the env describe them; the registry follows them while they don't change.

**Open seed**:
A seed whose key needs no token, so a call without one acts as the seed key.
_Avoid_: No-token mode

**Owner**:
The person on the seed pairing.
_Avoid_: Admin

**Hub**:
The part of the service that holds the registry in memory, runs every bot and routes each call by its API key.
_Avoid_: Daemon, manager
