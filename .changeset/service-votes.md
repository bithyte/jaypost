---
'jaypost': minor
---

`send request -u`, `--require` and `--retry` work in service mode too, through a new `POST /vote` route and a `retry` field on `POST /request`. The Node `Client` takes `retry` as well, answers with `rounds` when it's set, and has `vote()`.
