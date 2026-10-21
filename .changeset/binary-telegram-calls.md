---
'jaypost': patch
---

Fixed the standalone binary failing every Telegram call, so `jaypost init` rejected any bot token. Also silenced the `url.parse()` deprecation warning (DEP0169) it printed on the first Telegram request.
