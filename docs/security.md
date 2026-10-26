# Security

The API is meant for localhost only; don't expose it. The container targets publish the port on `127.0.0.1` only; keep it that way.

On top of that, `init` makes an API token and the service answers 401 without it. It stops other users on the machine, a browser page or a container that can reach the port from calling the API. It doesn't stop a process running as you: it can read `~/.config/jaypost/token` (mode 0600) like the CLI does. `init --no-token` turns it off, which leaves any local process able to ask or notify. Never use `--no-token` on a service you expose to other machines: a call without a token acts as key `k1`, so anyone who reaches the port can ask and notify as you.

To rotate it, delete the token file and re-run `init`.

A wrong token gets 401 even on an `init --no-token` install, which used to accept anything.

## Several people

On a [hosted service](hosting.md) every person has their own API keys. The service stores only a hash of each (the key is shown once, when it's created) and never returns one. The admin key is separate: it unlocks the admin routes and nothing else, can't ask or notify, and an API key never opens an admin route. It lives in `admin-key` next to `config.json` (the data volume for containers), mode 0600; `jaypost admin-key rotate` replaces it and the old one stops working at once. Treat it like the bot tokens, which also sit under that directory. `registry.json` holds bot tokens and the people ids, mode 0600 too.

A key holder can't see or affect another key's questions or log, and a key can't make the bot message someone who has never started a chat with it.

Exposure is up to you. The service listens on 127.0.0.1; to serve other machines put a reverse proxy with TLS in front, since jaypost has no TLS, and keys and the admin key cross the wire with every call. There are no quotas or rate limits.

The [question log](question-log.md) keeps question text and answers on disk (mode 0600, or inside the data volume). Agents sometimes put secrets in their questions, so treat the file like the other secrets under `~/.config/jaypost/`.
