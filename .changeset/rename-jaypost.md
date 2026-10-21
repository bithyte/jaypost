---
'jaypost': major
---

Renamed from `telegram-ask` to `jaypost`: the npm package, the command, the `JAYPOST_CONFIG` and `JAYPOST_TOKEN` env vars, the `~/.config/jaypost/` directory, the service, container, volume and LaunchAgent names, the release binaries (`jaypost-<platform>-<arch>.gz`) and the library's error class (`JaypostError`). Nothing else changes. There's no migration: jaypost doesn't read the old config, token or install. Run `telegram-ask uninstall`, then `jaypost init`, and update hook and MCP configs. See "Coming from telegram-ask" in the README.
