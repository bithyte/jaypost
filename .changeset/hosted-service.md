---
'jaypost': minor
---

One service can now hold several bots and serve several people, each through their own API key. New admin commands: `jaypost admin bot add|list|remove`, `admin bot contact add|list|remove`, `admin bot key add|revoke` and `admin rotate-key`, backed by `/admin` routes that take a separate admin key. `jaypost admin log` takes `--bot`, `--contact`, `--key` and `--all`, and `GET /log` returns a key's own questions. `GET /status` adds `key`, `contact`, `state` and `error`. `reset-owner` no longer restarts the service. Existing installs upgrade in place: the bot, owner and API token become `b1`, `c1` and `k1`. Behavior change: a wrong token on an install without a token now gets 401. Not included: TLS (use a reverse proxy), quotas and per-key voter lists. See docs/hosting.md.
