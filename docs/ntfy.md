# ntfy

[ntfy](https://ntfy.sh) needs no bot and no pairing: questions arrive as phone notifications with buttons. Use the public `ntfy.sh` server or your own (2.16 or later, see [Limits](#limits)).

## Setup

1. Install the ntfy app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy), [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/), [iOS](https://apps.apple.com/app/ntfy/id1625396347)) and subscribe to a topic. On `ntfy.sh` anyone who knows the topic name can read it and answer, so make it long and random, like `jaypost-` followed by the output of `openssl rand -hex 12`.
2. Run `jaypost init` and pick ntfy. It asks for the server (empty for `https://ntfy.sh`), the topic and an access token (empty for none).
3. `jaypost ping` sends a test notification.

There's no pairing step: the service is ready as soon as it starts. Without a token the topic has to be at least 16 characters.

For CI or `JAYPOST_MODE=direct`, set `JAYPOST_PROVIDER=ntfy`, `JAYPOST_NTFY_TOPIC` and, if needed, `JAYPOST_NTFY_SERVER` and `JAYPOST_NTFY_TOKEN`. `jaypost setup-ci` prints them for you.

## How answers come back

Each button publishes its answer to a second topic, your topic plus `-replies`, and the service keeps a subscription open to it. The phone only ever talks to the ntfy server, so the machine running jaypost doesn't need to be reachable from outside.

When a question ends, its notification is replaced with the final line (like `✅ Ship, 14:02`) and cleared from the notification shade; it stays in the app's message list. Notifications get a Dismiss button and are deleted after 8 hours, as on the other chat apps.

To type an answer, or to send a [bot command](bot.md) like `/pending`, publish a message to the `-replies` topic from the ntfy app (subscribe to it, then use the send button). A typed message answers the only open question that takes text; with several open it can't tell which one you meant, so answer the others with their buttons first. Replies to commands arrive on your main topic.

## Limits

- At most 3 options per question (ntfy shows 3 buttons). The Claude Code hook leaves out Always allow so its prompts fit.
- At most 1200 characters of text. ntfy turns longer messages into attachments.
- No attachments, and no votes or other approvers: there is only the one topic.
- Formatting is sent as plain text; the ntfy apps don't render markdown in notifications.
- Replacing and clearing a finished question needs ntfy server 2.16 or later. On an older server you get a second notification with the final line instead of the first one changing.
- On iOS, action buttons and notification updates depend on the ntfy app's support; it's been tested on Android and the web app only.
- `ntfy.sh` rate-limits anonymous use. If you ask a lot, use an account or your own server.

## Access tokens

On a server with access control, create a token with read and write access to both topics (`ntfy token add <user>`) and give it to `init`. The token is also put on each button so the phone can publish the answer, which means anyone who can read the topic can see it. Give jaypost a user that can only reach these two topics.
