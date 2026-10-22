---
'jaypost': minor
---

Every environment variable jaypost reads now starts with `JAYPOST_`: `JAYPOST_PROVIDER`, `JAYPOST_BOT_TOKEN`, `JAYPOST_OWNER_ID`, `JAYPOST_PORT`, `JAYPOST_HOST`. The old names (`PROVIDER`, `BOT_TOKEN`, `OWNER_ID`, `PORT`, `HOST`) are no longer read, so this breaks existing installs. For Quadlet and Compose, rename `PROVIDER`, `BOT_TOKEN`, `OWNER_ID` and `PORT` in the `.env` file to the `JAYPOST_` names before running `jaypost update`, since the new CLI reads that file (`~/.config/jaypost/quadlet/.env` for Quadlet, `~/.config/jaypost/compose/.env` for Compose; the directory moves if you set `JAYPOST_CONFIG` or `XDG_CONFIG_HOME`). If you set `PORT` or `HOST` for `jaypost start`, `mcp`, `hook` or `send`, rename those too. `jaypost update` refuses to update a Quadlet or Compose install until its `.env` is renamed.
