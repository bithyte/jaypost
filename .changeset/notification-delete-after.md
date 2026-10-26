---
'jaypost': minor
---

Notifications take `deleteAfter` (`delete_after` on `notify_user`, `--delete-after` on `notify`): seconds, or an ISO 8601 timestamp, until the bot deletes it. It isn't shifted by quiet hours and is capped at 47 hours; without it a notification keeps the 8-hour default. `jaypost hook` sends idle-prompt notifications with 300 seconds. Needs a service at least this new; an older one ignores the field. Direct mode can't delete, so it ignores it too.
