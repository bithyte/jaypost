# Security

The API is meant for localhost only; don't expose it unless you mean to (see `--exposed` below). The container targets publish the port on `127.0.0.1` only unless you install with `--exposed`.

On top of that, `service install` makes an API token and the service answers 401 without it. It stops other users on the machine, a browser page or a container that can reach the port from calling the API. It doesn't stop a process running as you: it can read your contact book, `~/.config/jaypost/bots.json` (mode 0600), like the CLI does. `service install --no-token` turns it off, which leaves any local process able to ask or notify. Never use `--no-token` on a service you expose to other machines: a call without a token acts as key `k1`, so anyone who reaches the port can ask and notify as you.

Every key and admin key you hold lives in `bots.json`, written atomically with mode 0600; `jaypost bots` and `remote list` never print them. To rotate the local API token, remove `apiToken` from `service/config.json` (or the target's `.env`) and run `jaypost service install` again; to rotate an admin key use `jaypost admin rotate-key`.

A wrong token gets 401 even on a `service install --no-token` install, which used to accept anything.

## Several people

On a [hosted service](hosting.md) every person has their own API keys. The service stores only a hash of each (the key is shown once, when it's created) and never returns one. The admin key is separate: it unlocks the admin routes and nothing else, can't ask or notify, and an API key never opens an admin route. It lives in `admin-key` next to `config.json` in `~/.config/jaypost/service/` (the data volume for containers), mode 0600, and a copy sits in your `bots.json`; `jaypost admin rotate-key` replaces it and the old one stops working at once. Treat it like the bot tokens, which also sit under that directory. `jaypost.db` (also next to `config.json`) holds bot tokens, key hashes and people ids, mode 0600 too, as are its `-wal` and `-shm` files.

A key holder can't see or affect another key's questions or log, and a key can't make the bot message someone who has never started a chat with it.

Exposure is up to you. The service listens on 127.0.0.1. `service install --exposed` makes it listen on all interfaces (0.0.0.0) over plain http, so API keys and the admin key cross the network in the clear: use it only on a LAN, or put your own TLS proxy in front, since jaypost has no TLS. The `jaypost remote add` line it prints holds the admin key. An invite (`jaypost join jpi_...`) holds an API key, so send it privately. There are no quotas or rate limits.

The [question log](question-log.md) keeps question text and answers on disk (mode 0600, or inside the data volume). Agents sometimes put secrets in their questions, so treat the file like the other secrets under `~/.config/jaypost/`.
