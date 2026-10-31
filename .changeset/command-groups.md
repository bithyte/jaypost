---
'jaypost': minor
---

`setup-ci` and `reset-owner` moved under `jaypost pair`, as `pair ci` and `pair reset-owner`, next to `pair approver`, and `update` is now `service update`. The old names are gone; a 0.9.0 `jaypost update` can't finish the hand-off to the new CLI, so run `jaypost service update` after it. `jaypost openapi` still works but is no longer listed in `jaypost --help`.
