---
'jaypost': minor
---

`jaypost hook` handles `Stop`: when Claude finishes and nobody types for a minute, its last message goes to the phone, and a text reply wakes Claude with it as the next prompt (through Claude Code's `asyncRewake`). `UserPromptSubmit` and `SessionEnd` cancel a question that's still waiting. The plugin turns this on and drops `idle_prompt` from its notifications, since the new message covers the same moment.
