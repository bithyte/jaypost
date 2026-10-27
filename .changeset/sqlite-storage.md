---
'jaypost': minor
---

The service keeps its bots, pairings, keys, pending requests and question log in one `jaypost.db` next to `config.json`, instead of `registry.json` and the per-bot `state.json` and `audit.jsonl`. The old files aren't read, so rerun `jaypost init` after upgrading; the registry starts empty. The question log keeps 30 days, and `/admin/log` still reads a removed bot's questions until then. Needs Node 24.15 or newer.
