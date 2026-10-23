# Security

The API is meant for localhost only; don't expose it. The container targets publish the port on `127.0.0.1` only; keep it that way.

On top of that, `init` makes an API token and the service answers 401 without it. It stops other users on the machine, a browser page or a container that can reach the port from calling the API. It doesn't stop a process running as you: it can read `~/.config/jaypost/token` (mode 0600) like the CLI does. `init --no-token` turns it off, which leaves any local process able to ask or notify.

To rotate it, delete the token file and re-run `init`.

With [ntfy](ntfy.md) there's no pairing: anyone who can publish to your topic's `-replies` topic can answer questions, and anyone who can read the topic sees them. On the public `ntfy.sh` server that's anyone who knows the topic name, so `init` wants at least 16 characters without an access token; use a long random one. With a token on a server that checks it, the token is put on each button and so is readable by anyone who can read the topic. See [Access tokens](ntfy.md#access-tokens).

The [question log](question-log.md) keeps question text and answers on disk (mode 0600, or inside the data volume). Agents sometimes put secrets in their questions, so treat the file like the other secrets under `~/.config/jaypost/`.
