---
'jaypost': minor
---

Direct mode for CI. With `JAYPOST_MODE=direct`, `jaypost send` talks to the chat app itself instead of a running service, using `JAYPOST_PROVIDER`, `JAYPOST_BOT_TOKEN` and `JAYPOST_OWNER_ID`. Direct `send request` exits 3 when the answer is the `-d` value or the timeout fired, so a CI step can gate on it; service mode still exits 0 for any answer. New `jaypost setup-ci` pairs an owner and prints the env vars to store as GitHub secrets. The env var rename it relies on is in the `JAYPOST_` prefix changeset.
