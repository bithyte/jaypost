---
'jaypost': minor
---

Several approvers for direct mode. `jaypost send request` takes `-u ID` once per approver, `--require all|majority` to say how the votes decide, and `--retry N` to ask again after a timeout. A vote exits 0 when approved and 3 when rejected, and `--json` adds the tally. The flags exit 2 outside direct mode. `jaypost setup-ci` can pair the approvers and prints their `-u` flags, and `--approvers-only` pairs more of them later without the owner.
