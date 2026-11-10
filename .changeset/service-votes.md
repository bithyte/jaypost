---
'jaypost': minor
---

`request -u`, `--require` and `--retry` work in service mode too: `POST /request` runs a vote when the body has `voters` or `require`, and takes `retry`. Votes take any number of `-o`; once no answer but the `-d` one can win, the vote ends on it. The Node `Client` takes `retry` as well, answers with `rounds` when it's set, and has `vote()`.
