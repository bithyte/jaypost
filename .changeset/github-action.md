---
'jaypost': minor
---

A GitHub Action: `uses: bithyte/jaypost@v0` runs `send request` or `send notify` in direct mode from the release binary, fails the step on a No or a timeout, and sets the `answer` output. `install.sh` reads `JAYPOST_INSTALL_DIR` and `JAYPOST_NO_INIT`.
