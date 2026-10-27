# jaypost

jaypost lets agents, scripts and CI ask a person a question or notify them on a chat app, and wait for the answer. One service holds several bots and serves several people.

## Language

### Who is reached, and how

**Bot**:
One chat app account (a Telegram bot, a Discord bot) the service runs.
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
_Avoid_: Token (the pre-registry name, kept only for the seed key's file)

**Admin key**:
The secret that manages bots, pairings and keys. It can't ask or notify.

### Storage and the install

**Registry**:
Every bot, pairing and API key of one install.
_Avoid_: Database, config

**Seed**:
Bot 1, pairing 1 and key 1 as init or the env describe them; the registry follows them while they don't change.

**Open seed**:
A seed whose key needs no token, so a call without one acts as the seed key.
_Avoid_: No-token mode

**Owner**:
The person on the seed pairing.
_Avoid_: Admin

**Hub**:
The part of the service that holds the registry in memory, runs every bot and routes each call by its API key.
_Avoid_: Daemon, manager
