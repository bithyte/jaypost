---
'jaypost': patch
---

`init` for systemd and launchd drops a saved owner id the provider can't parse (say, a Discord id left in `config.json` under a Telegram install) and goes on to pairing. Before, it kept the id and the service crash-looped on start.
