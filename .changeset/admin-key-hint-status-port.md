---
'jaypost': patch
---

A rejected admin key saved for a remote now says to run `jaypost admin remote add` again even when `JAYPOST_ADMIN_KEY` is set, since that env key isn't what was sent. `jaypost status` now asks the url it resolved when that url is on this machine but not on the install's port. Before, it reported the install, and failed if the install was stopped.
