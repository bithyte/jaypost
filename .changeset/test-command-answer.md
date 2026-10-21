---
'jaypost': patch
---

`jaypost test` now prints the answer, the way `jaypost send request` does, instead of the HTTP status and raw body. It no longer goes through `fetch`, so a test left unanswered for the full 300 s doesn't hit fetch's headers timeout.
