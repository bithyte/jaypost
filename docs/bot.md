# Bot commands

Send these to the bot in your private chat (on Discord, its DM):

- `/pending` lists the open requests, with the time left and the answer each gets on timeout. A text question shows `or a typed reply` after its buttons, or `Typed reply` alone if it has none.
- `/cancel` rejects every open request with its `timeoutOption`.
- `/history [N]` shows the last N answers, newest first (default 10, max 20).
- `/mute [duration]`, `/unmute` and `/quiet` control [quiet hours](#quiet-hours).

Only the paired owner's private chat gets replies. History is kept in memory and resets on restart. A request that is still being sent when you run `/cancel` isn't rejected.

## Quiet hours

Notifications can go out silently: they still show up in the chat, but without a sound or buzz. Approvals always ping, quiet or not, since an agent is blocked waiting on you.

| Command              | Effect                                                                     |
| -------------------- | -------------------------------------------------------------------------- |
| `/mute [duration]`   | Silence notifications from now. Default 1 hour. Replaces any earlier mute. |
| `/unmute`            | End the mute early. Quiet hours still apply.                               |
| `/quiet`             | Show the quiet hours, the time zone, the mute and whether it's silent now. |
| `/quiet 23:00-08:00` | Silence notifications every day in that window. It can wrap midnight.      |
| `/quiet off`         | Remove the quiet hours.                                                    |

A duration is `30m`, `2h`, `1d` or a combination in that order (`1h30m`, `1d12h`), at most `7d`. A bare number is rejected. Window times are 24-hour; `23-8` and `7:30-9` work too, and start and end can't be equal.

Both settings are saved in `config.json` as `quietHours` (`"23:00-08:00"`) and `mutedUntil` (an ISO timestamp), so they survive a restart. You can also edit them there; a hand edit applies on restart, and an invalid `quietHours` stops startup. When a mute passes, it just stops applying.

Windows use the service's own time zone, and replies that set or show a time name it. The systemd and launchd targets use the host's. `init` writes `TZ` into the Compose and Quadlet `.env` so the container matches the host. Container installs from before this release use UTC until you re-run `init`.

A notification sent while quiet is deleted 8 hours after the quiet period ends, not 8 hours after it was sent, so you get a chance to see it. If that would be more than 47 hours out (Telegram won't let a bot delete older messages), it isn't deleted automatically and stays until you dismiss it.
