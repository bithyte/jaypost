# HTTP API

## Ask a question

```
curl -s -X POST http://127.0.0.1:8787/request \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.config/jaypost/token)" \
  -d '{"text":"Deploy?","options":["Approve","Decline"],"timeoutOption":"Decline","timeout":60}'
```

The request stays open until you tap a button (or reply, see below) or the timeout fires, then returns `200`:

```json
{ "answer": "Approve", "timedOut": false }
```

On timeout, `answer` is `timeoutOption` and `timedOut` is `true`. If the owner sends `/cancel`, every open request returns its `timeoutOption` with `timedOut: false`. Many requests can be pending at once.

For a question with no sensible buttons, set `allowText` and leave out `options`; you answer by replying with text:

```
curl -s -X POST http://127.0.0.1:8787/request \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.config/jaypost/token)" \
  -d '{"text":"Which branch?","allowText":true,"timeoutOption":"main","timeout":120}'
```

Reply to the question's message in Telegram; if it's the only open text question, just typing works. The first answer wins, whether it's a tap or a reply. Non-text replies don't count, and a registered command name (`/pending`, `/cancel`, `/history`) can't be typed as an answer.

`allowText` needs a service at least as new as this release. An older one ignores it: with `options` you get a buttons-only question, without them a 400 `options must be a non-empty array`. Re-run `init` to upgrade.

`POST /request` body:

| Field           | Type     | Required           | Notes                                                                                                                        |
| --------------- | -------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `text`          | string   | yes                | Question shown in the chat app. Non-empty, max `maxTextLength` chars (with `markdown`, counted after the markup is removed). |
| `allowText`     | boolean  | no                 | Default `false`. When true, a text reply from the owner answers the question.                                                |
| `options`       | string[] | unless `allowText` | Button labels. Non-empty, unique, non-empty strings. With `allowText`, may be omitted or `[]` for a text-only question.      |
| `timeoutOption` | string   | yes                | Answer returned on timeout. Must be one of `options`; with `allowText`, any non-empty string up to 64 chars.                 |
| `timeout`       | number   | no                 | Seconds. Default 300, max 86400 (24 h); longer values are capped. Must be positive.                                          |
| `project`       | string   | no                 | Shown as `[project]` on the first line. Trimmed, max 100 chars. Counts toward `maxTextLength`.                               |
| `format`        | string   | no                 | `plain` (default) or `markdown`. See [Formatting](formatting.md).                                                              |
| `attachment`    | object   | no                 | One file sent with the question. See [Attachments](#attachments).                                                            |
| `retry`         | integer  | no                 | 0 to 100. Asks again after a timeout up to this many times; the answer then has `rounds`. Not on `/request/async`.          |

The cap used to be 300, so a `timeout: 900` was clamped to 300 before and now waits the full 900 s.

Callers on Node's global `fetch` (undici, 300 s headers timeout) should keep `timeout` at 290 or less (an attachment eats into that headroom, since its Telegram upload happens before the timer starts), raise `headersTimeout` with a custom dispatcher, or use [`POST /request/async`](#background-questions). curl, `node:http` and this package's CLI, `Client` and MCP server aren't affected.

Errors are JSON `{ "error": "..." }`:

| Status | Meaning                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Body isn't valid JSON or fails validation (on Discord, more than 25 `options` is `options must have at most 25 entries`). Nothing is sent to the chat app. |
| 401    | Missing or wrong token. A wrong token gets 401 on an install without a token too.                                                                          |
| 413    | Body over 14 MiB.                                                                                                                                          |
| 501    | The body has an `attachment` and the provider can't send files (`attachments not supported`).                                                              |
| 502    | Message couldn't be sent.                                                                                                                                  |
| 503    | The key's bot isn't `running` (see `state` in [`GET /status`](#status)), or isn't paired yet.                                                              |
| 500    | Internal error, or the request was cancelled.                                                                                                              |
| 404    | Path isn't `/request`, `/request/async`, `/request/{id}`, `/vote`, `/notify`, `/status`, `/log`, `/admin/...` or `/openapi.yaml`.                          |
| 405    | Method isn't the one the path takes (POST, or GET and DELETE for `/request/{id}`).                                                                         |

If the caller disconnects early, the request is dropped and the Telegram message is edited to a "cancelled" line. A restart still drops pending requests (callers see a connection error), but when the service comes back it edits their Telegram messages to an expired line.

## Background questions

`POST /request/async` takes the same body and sends the same message, but answers `202` as soon as it is sent, so no connection has to stay open. It checks pairing like `/request`; the routes below only need the token.

```
curl -s -X POST http://127.0.0.1:8787/request/async \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.config/jaypost/token)" \
  -d '{"text":"Deploy?","options":["Approve","Decline"],"timeoutOption":"Decline","timeout":3600}'
```

```json
{ "id": "6f1c...", "state": "pending", "expiresAt": "2026-10-19T12:00:00.000Z" }
```

The `Location` header is `/request/{id}`. `GET /request/{id}` returns the state: `pending` as above, `{ "id": "...", "state": "done", "answer": "Approve", "timedOut": false }` once settled, or `{ "id": "...", "state": "cancelled" }` after a cancel. Add `?wait=SECONDS` (max 120, larger values are clamped) to hold the request until the question settles or the time runs out; it returns the moment the question settles. Loop on it until `state` isn't `pending`. A `wait` that isn't a non-negative number is a `400`. Closing a long-poll doesn't cancel the question.

`DELETE /request/{id}` cancels a pending question (the Telegram message becomes a "cancelled" line) and returns its state, and a following `GET` agrees. On an already settled question it just returns that state. An unknown id answers `404` with `{ "error": "unknown request" }`. Settled questions are kept for 24 h.

Version skew: a service from before this release clamps `timeout` to 300 s and answers `404` to these paths, so a client that needs long timeouts should check the service version first (`info.version` in `GET /openapi.yaml`). A restart drops background questions (`404` afterwards), and their Telegram messages get the expired line on the next start. A bot restarted after a fatal error drops its background questions the same way: polling one answers `503` while the bot is down, then `404`.

## Send a notification

For messages that don't need an answer, e.g. from n8n when someone joins a game server:

```
curl -s -X POST http://127.0.0.1:8787/notify \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.config/jaypost/token)" \
  -d '{"text":"alice joined the Core Keeper server"}'
```

It returns `200 { "ok": true }` as soon as Telegram accepts the message. The message has a Dismiss button that deletes it, and it's deleted automatically after 8 hours. During [quiet hours](bot.md#quiet-hours) or a mute it's sent silently (no sound or buzz) and the 8 hours start when the quiet period ends.

`POST /notify` body:

| Field        | Type   | Required | Notes                                                                                                               |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `text`       | string | yes      | Shown in the chat app. Non-empty, max `maxTextLength` chars (with `markdown`, counted after the markup is removed). |
| `project`    | string | no       | Shown as `[project]` on the first line. Trimmed, max 100 chars. Counts toward `maxTextLength`.                      |
| `format`     | string | no       | `plain` (default) or `markdown`. See [Formatting](formatting.md).                                                     |
| `attachment` | object | no       | One file sent with the message. See [Attachments](#attachments).                                                    |

Errors are JSON `{ "error": "..." }`:

| Status | Meaning                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------- |
| 400    | Body isn't valid JSON or fails validation. Nothing is sent to Telegram.                            |
| 401    | Missing or wrong token.                                                                            |
| 413    | Body over 14 MiB.                                                                                  |
| 501    | Notifications aren't supported, or the body has an `attachment` and the provider can't send files. |
| 502    | Message couldn't be sent.                                                                          |
| 503    | Not paired yet.                                                                                    |
| 405    | Method isn't POST.                                                                                 |
| 500    | Internal error.                                                                                    |

## Votes

`POST /vote` asks several people the same yes/no question, one message each, and stays open until the vote is decided. The body is a `/request` body whose `options` are `[approve, reject]`, with `timeoutOption` the reject answer and no `allowText`, plus:

| Field     | Type     | Required | Notes                                                                                                  |
| --------- | -------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `voters`  | string[] | no       | User ids, 1 to 25. Default: the owner. Each one must have started a chat with the bot.                 |
| `require` | string   | no       | `all` (default) or `majority`. A tie rejects.                                                           |
| `retry`   | integer  | no       | 0 to 100. Rounds after the first; each re-asks only voters who haven't voted. Running out rejects.     |

```
curl -s -X POST http://127.0.0.1:8787/vote \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.config/jaypost/token)" \
  -d '{"text":"Publish v123?","options":["Yes","No"],"timeoutOption":"No","voters":["111","222","333"],"require":"majority"}'
```

```json
{
  "answer": "Yes",
  "timedOut": false,
  "approved": true,
  "require": "majority",
  "votes": { "111": "Yes", "222": "Yes", "333": null },
  "rounds": 1
}
```

`votes` has `null` for anyone who didn't vote, and `timedOut` means the rounds ran out. Errors are the same as `/request`, except a `502` also names the voter whose message couldn't be sent (`{"error":"failed to send message","voter":"222"}`); the messages already sent are cancelled. Disconnecting cancels every open message. This is what `jaypost request -u ... --require ...` calls in service mode.

## Attachments

`POST /request`, `POST /request/async` and `POST /notify` take an optional `attachment`, one file shown as a document above the message. It stays after the question is answered and is deleted with the notification.

On Telegram the file arrives as a document right above the message, always without a notification sound (quiet hours or not); the message replies to it. Tapping Dismiss on a notification deletes the document too.

| Field             | Type   | Required       | Notes                                                                                                                                                        |
| ----------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attachment.name` | string | yes            | File name shown in Telegram; its extension decides how Telegram opens it. Max 255 chars, no `/` or `\`, no control characters, not `.` or `..`. Not trimmed. |
| `attachment.text` | string | one of the two | File contents as UTF-8 text.                                                                                                                                 |
| `attachment.data` | string | one of the two | File contents as base64 (standard alphabet, padding optional, whitespace ignored).                                                                           |

Send exactly one of `text` and `data`. The content must be at least 1 byte and at most `maxAttachmentBytes` from [`GET /status`](#status) (10 MiB for Telegram); over it is a `400 attachment must be at most N bytes`. A bad `attachment` is a `400` with an `attachment...` message, and `null` counts as bad. A provider without file support answers `501 attachments not supported` for any body with an `attachment` key.

```
curl -s -X POST http://127.0.0.1:8787/request \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.config/jaypost/token)" \
  -d '{"text":"Push this diff?","options":["Push","Stop"],"timeoutOption":"Stop",
       "attachment":{"name":"changes.diff","text":"diff --git a/x b/x\n..."}}'

jq -n --arg data "$(base64 -w0 screen.png)" \
  '{text:"Login page is blank, see screenshot",attachment:{name:"screen.png",data:$data}}' |
  curl -s -X POST http://127.0.0.1:8787/notify \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $(cat ~/.config/jaypost/token)" -d @-
```

The body limit is 14 MiB, which fits the base64 of a 10 MiB file. Send big files as `data`: a `text` attachment near 10 MiB with many quotes or control characters grows when JSON-escaped and can hit the `413`.

Attachments need a service at least as new as this release; an older one ignores the field. Clients check `maxAttachmentBytes` first and say so if it's missing.

## Status

`GET /status` needs the token too. It returns `provider` and `displayName` along with `paired` and `bot`, plus `code` and `instructions` while unpaired. It also names the caller's `key` and `pairing` ids, and the `state` of the key's bot: `starting`, `running`, or `failed` with an `error`. A failed bot is retried with backoff and question routes answer 503 until it's `running`. `maxTextLength` is the longest `text` a request may have, which depends on the provider (3900 on Telegram, 1800 on Discord). `maxOptionCount` is the most `options` a request may have; it's present only when the provider has a limit (25 on Discord) and absent on Telegram. `maxAttachmentBytes` is the largest attachment the provider takes, `0` when it can't send files; a service from before attachments leaves it out. `jaypost status` is the friendlier way to read it.

## Log

`GET /log` returns the questions asked with the caller's key, oldest first, as `{ "entries": [...], "skippedCount": 0 }`. `skippedCount` is how many log lines couldn't be read. It takes `since` (a duration like `7d`, a date or an ISO date-time), `project` and `limit` (the last N); a bad or repeated parameter is a `400`. Each entry has `id`, `askedAt`, `text`, `options`, `timeoutOption`, `timeoutSeconds`, `status` and, once known, `answer` and `settledAt`, plus the `key` and `pairing` it came from. See [Question log](question-log.md).

```
curl -s "http://127.0.0.1:8787/log?since=7d" -H "authorization: Bearer $(cat ~/.config/jaypost/token)"
```

## Admin routes

The admin routes manage bots, pairings and keys on a running service, so a remote admin or another app can drive them. They take the admin key as the bearer token, not an API key; an API key, a missing key or a wrong one gets `401`, and the admin key gets `401` on every other route except `/openapi.yaml`, which takes no key at all. Bodies are JSON and error messages never quote them. Secrets are never echoed: the API key's plaintext comes back once, from `POST /admin/keys`, and hashes are never returned.

| Route                             | Does                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/bots`                 | Bots with `state` (`starting`, `running`, `failed`), `error`, `pairingCount` and `keyCount`. Never their settings.                                  |
| `POST /admin/bots`                | `{ "provider", "settings", "label"? }`. Adds a bot, `201`, already starting. `settings` never holds the owner. Credentials another bot uses are rejected. |
| `DELETE /admin/bots/{id}`         | Removes the bot, its pairings and keys; returns `removedKeys`.                                                                                      |
| `GET /admin/pairings`             | Pairings, with `person` once paired, `code` while pending and their `keys`. `?bot=` filters.                                                        |
| `POST /admin/pairings`            | `{ "bot" }`. A pairing with no key, `201`, with its `code` and `instructions`.                                                                      |
| `POST /admin/pairings/{id}/reset` | Forgets the person and gives the pairing a fresh code. Rejects the open questions of its keys with their timeout option.                            |
| `DELETE /admin/pairings/{id}`     | Removes the pairing and revokes its keys; returns `removedKeys`.                                                                                    |
| `GET /admin/keys`                 | Keys without hashes. `?bot=` and `?pairing=` filter.                                                                                                |
| `POST /admin/keys`                | Exactly one of `bot` (new pairing, returns a `code`), `pairing` or `sameAsKey`, plus `label` and `externalId`. `201` with the plaintext `key`.       |
| `PATCH /admin/keys/{id}`          | `label` and `externalId`: a string sets, `null` clears, absent keeps.                                                                               |
| `DELETE /admin/keys/{id}`         | Revokes the key and ends its open questions with their timeout option. Its pairing stays.                                                           |
| `GET /admin/log`                  | Every bot's questions, each with its `bot`. Filters `bot`, `pairing`, `key`, `since`, `project`, `limit`.                                            |
| `POST /admin/admin-key`           | Replaces the admin key and returns the new one. The old key stops working at once and the key file is rewritten.                                    |

`/admin/log` doesn't `404` on a `pairing` or `key` id that no longer exists, so the history of revoked keys and removed pairings stays readable. A removed bot's log can't be read through the API; its files stay on disk under `bots/<id>/`. A registry write that fails answers `500` and changes nothing. Unknown ids on the other routes answer `404`. Use the [CLI](commands.md#admin) rather than calling these by hand, unless you're building on top of them. See [Hosting](hosting.md).

## OpenAPI spec

The API is described in OpenAPI 3.1: [`docs/openapi.yaml`](openapi.yaml) (port 8787, Telegram's text limit), `GET /openapi.yaml` on a running service, or `jaypost openapi [FILE]`. The last two use the install's port and its provider's text limit. Regenerate the docs copy with `vp run openapi`.
