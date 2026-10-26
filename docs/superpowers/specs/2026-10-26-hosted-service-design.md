# Hosted service

## Intent

jaypost today is a single-owner daemon on localhost: one bot, one paired chat account, one API token. Two things want more than that:

- Several CI workflows sharing one bot. Today a pipeline that wants the daemon's bot has to use direct mode, and two processes polling one Telegram bot fight over its updates.
- Other people using a bot someone else runs.

The goal is for the existing service to become a hosted, multi-tenant one. It runs on a VM, holds any number of bots from any providers, and serves many people through API keys. The local install is the same service with one bot and one key. There's one product, not a daemon plus a separate relay.

Users are invited by the admin. There's no public signup. A later cloud version, where anyone registers on a site and uses a shared "public" bot, should stay possible without reworking this design. In that version a separate app owns user accounts and acts as an admin client of jaypost, asking it for keys. jaypost itself never has user accounts.

This builds on the relay prep (`2026-10-23-relay-server-design.md`), which split `startBot` from the HTTP API and put a `BotRouter` in front of it. That spec's open items (several bots, token-to-bot routing, who a vote may reach, per-bot logging) are covered here.

## Model

Four things are stored.

- **Bot**: one provider runtime with its credentials (a Telegram bot, a Discord bot, ...). Several bots per provider are allowed.
- **Pairing**: a bond between one bot and one chat person, made once with a pairing code. A pairing can exist without any key, for example for someone who only approves votes.
- **API key**: points to exactly one pairing, so to one bot and one person. Questions and notifications sent with it go to that person on that bot.
- **Admin key**: one per install. Unlocks the admin routes only.

A "user with several keys" is the outside world's idea, not jaypost's. Several keys pointing at the same pairing is how one person gets one key per CI workflow without pairing again.

## Behavior

### Keys and pairing

- The admin creates a key in one of two ways:
  - **new pairing**: the key comes with a pairing code. It isn't usable for questions until someone pairs with that code. The code is shown to the admin when the key is created, and also comes back from `GET /status` called with the key while unpaired, so the key holder can find it.
  - **existing pairing**: "same person as key X" or "same as pairing P". It works right away. No phone step.
- The first successful pairing claims the key's pairing. A second person can't take it over later.
- The admin can also create a pairing with no key (an approver invite), which gives a code the same way.
- Revoking a key leaves its pairing alone. Removing a pairing revokes all its keys.
- The admin can rename a key or give it a free-form label or external id, which jaypost stores and never interprets. The cloud app will use this to map keys to its own users.

### Votes

- `/vote` keeps today's rule for every key: a voter must be someone the bot has talked to before (they started a chat with it, for example by pairing). Approvers don't need keys.
- There are no per-key approver lists in this version. The user's concern is only that the bot never cold-messages a stranger, and today's rule already covers it.
- Keep the door open: if per-key lists are wanted later, they should come in as a new per-key voter rule, with today's rule as the default, so existing keys and scripts keep their meaning.

### What a key holder can and can't do

- Ask, ask in the background, vote, notify, check status, and read the question log for their own key only.
- No admin action. A regular key never unlocks an admin route.
- In the chat, bot commands (`/pending`, `/cancel`, `/history`) only cover questions addressed to the sender. A chat person who isn't paired on that bot gets no answer, as today.

### Logs

- Every audit line records the key it came from (and so the pairing and bot).
- A key holder reads only their key's lines through the API.
- The admin reads everything, filtered by bot, pairing or key.

### Admin

- One admin key, separate from the API keys. Admin actions are HTTP routes on the same port, so they work from the VM or over the internet. The future cloud app is just another admin client.
- Admin actions: add, list and remove bots; create, list, label and revoke keys; create, list and remove pairings; read all logs; rotate the admin key.
- The CLI's admin commands call those routes. On the machine itself they find the admin key in a local file (mode 0600, like `token` today), so the admin never pastes it. From elsewhere they take `JAYPOST_URL` plus the admin key from an env var.
- The admin key can't send questions. The admin uses a regular key for that like anyone else.
- Admin changes apply to the running service without a restart. This is required because the admin may be remote.

### Setup and existing installs

- `jaypost init` sets up the service as now. The result is one bot, one pairing (the person running it, once they pair), one key (written to the token file the CLI, hook, plugin and MCP server already read) and the admin key.
- `jaypost add_bot` (the name the user used; see "Left to the builder") adds another bot to a running or stopped service at any time.
- An existing install upgrades in place. Its config becomes bot 1, its owner becomes pairing 1 and its `apiToken` becomes key 1, pointing at pairing 1. Current clients keep working with no new setup: `JAYPOST_TOKEN`, the token file, the plugin, the hook and `JAYPOST_URL`.
- `reset-owner` keeps working: it removes pairing 1's person and waits for a new pairing of key 1.
- Direct mode, `setup-ci`, `pair approver` for direct mode and the GitHub Action are untouched.

### Exposure

- The service keeps listening on 127.0.0.1 by default. Making it public means putting a reverse proxy in front of it that terminates TLS. jaypost doesn't handle certificates.

## Goals

- One service that runs as today on a laptop and as a shared service on a VM.
- Many bots across providers in one process, added at runtime.
- Each key reaches exactly one person on one bot, with logs scoped to that key.
- CI workflows share a bot without pairing again and without fighting over updates.
- The admin can manage everything remotely through an API, so a future cloud app can drive it.

## Non-goals

- User accounts, sign-in, signup, a web UI.
- TLS termination, and reverse-proxy setup tooling. Tooling may come later.
- Quotas, rate limits per key, billing.
- Bots owned or registered by users. Only the admin adds bots.
- Changes to direct mode or the GitHub Action.

## Anti-goals

These would make it a failure even if it technically works.

- An upgrade breaks an existing local install, or forces its user to re-pair or reconfigure clients.
- A key holder sees or affects another key's questions, logs or chat person, through the API or the bot's commands.
- A key gets the bot to message someone who has never talked to it.
- A regular key can do anything an admin can.
- Adding a key or bot needs a restart or an SSH session.

## Constraints

- The repo's TypeScript style and package layout (`packages/core`, `store`, `service`, `providers`, `apps/cli`). Node 24, no build step.
- Pure core, I/O at the edges. Core logic such as `Conversation` and `Pairing` stays free of storage.
- The HTTP API stays compatible for existing calls. New fields and routes are fine. Changed meanings for existing ones are not.
- Secrets (bot tokens, keys, the admin key) are never logged or echoed back in errors.

## What changes in the code

These are the known seams, not a plan.

- `Conversation` (`packages/core/src/conversation/conversation.ts`) holds one `#ownerId`, and a successful pairing overwrites it. It needs many paired people per bot. Questions already carry an optional `recipient` (used for votes), which fits sending each question to its key's person.
- `Pairing` holds one code per bot. It needs several outstanding codes per bot, each tied to a pending pairing.
- `BotRouter.route` returns only a bot. It needs to return the key (and so its pairing) too, so routes can address questions and scope logs. Admin routes authenticate separately.
- `startBot` (`packages/service/src/daemon/bot.ts`) saves the owner into the bot's `config.json`. Pairings move to the new store.
- `resolveVoters` falls back to the single owner. It needs to fall back to the key's person instead.
- `AskedRecord` and `SettledRecord` in the audit log have no key field. One gets added, and readers filter on it.
- Owner commands (`runOwnerCommand`) work on the whole `ApprovalService`. They need to filter to the sender's questions.
- Quiet hours and mute live in the bot's `config.json`, so on a shared bot one person muting would silence everyone. They move to the pairing (see my calls).
- `startService` and `runService` start one bot from one config. They need to start every stored bot and add or stop bots while running.

## Calls I made

Some came up in the conversation as my guesses and weren't contradicted. Others settle questions from a review of this document. The user should check them.

- Keys are stored hashed and looked up by hash, unlike today's plaintext `apiToken`. Migration hashes the existing token, and the client token file stays as is.
- Removing a pairing revokes its keys. Revoking a key cancels its open questions with their timeout option.
- `/vote` without voters goes to the key's own person, as today with the owner.
- Quiet hours and mute are per pairing, set by that person through the bot's commands. Migration moves today's values to pairing 1.
- The admin key works even on an install made with `init --no-token`. Admin routes always need it.
- Adding a bot whose credentials are already used by another stored bot is rejected, since two runtimes on one Telegram token fight over updates.
- The terminal provider has no pairing, so its keys skip the pairing step.
- Rotating the admin key invalidates the old one immediately.
- The store is the source of truth. Env vars (`JAYPOST_BOT_TOKEN`, `JAYPOST_OWNER_ID`, `JAYPOST_TOKEN`, `JAYPOST_PROVIDER`, as the container installs' `.env` sets them) only seed bot 1, pairing 1 and key 1 when the store is empty. After that they're ignored, so admin changes aren't undone on restart. The admin key file lives with the store (inside the data volume for containers), and the host CLI reaches a container install through the admin routes.
- One pairing per (bot, chat person). If someone already paired on a bot redeems another code on it, the key behind that code points to their existing pairing.
- On an `init --no-token` install, calls without a token act as key 1. A wrong token still gets 401.
- One bot failing (rejected credentials, a fatal provider error) doesn't stop the others or the process. The bot shows as failed in `/status` for its keys and in the admin list, and is retried with backoff. This holds for a single-bot install too.
- Re-running `init` keeps the store. It only touches bot 1, key 1 and the admin key.

## Left to the builder

- Storage format: JSON files with the existing atomic write (one registry plus a directory per bot for state and audit), or SQLite. It's a single process, so locking isn't a concern either way.
- Admin route paths and payloads, and how they show up in `openapi.yaml`.
- CLI command names and shape. The user said `jaypost add_bot`, but existing commands are kebab-case or subcommands (`reset-owner`, `pair approver`). Match the existing style, for example `jaypost bot add` and `jaypost key create`.
- Key format (prefixes, length), as long as existing tokens stay valid.
- Whether `jaypost log` on the VM reads files directly or goes through the admin routes.
- Per-bot log lines (naming the bot, not just the provider).
- How and when the migration of an existing install runs (on start, or on `update`).
