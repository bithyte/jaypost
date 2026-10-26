---
'jaypost': minor
---

One service can now hold several bots and serve several people, each through their own API key. New admin commands: `jaypost bot add|list|remove`, `key create|list|label|revoke`, `pairing create|list|remove` and `admin-key rotate`, backed by `/admin` routes that take a separate admin key. `jaypost log` takes `--bot`, `--pairing`, `--key` and `--all`, and `GET /log` returns a key's own questions. `GET /status` adds `key`, `pairing`, `state` and `error`. `reset-owner` no longer restarts the service. Existing installs upgrade in place: the bot, owner and API token become `b1`, `p1` and `k1`. Behavior change: a wrong token on an install without a token now gets 401. Not included: TLS (use a reverse proxy), quotas and per-key voter lists. See docs/hosting.md.
