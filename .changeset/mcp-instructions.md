---
'jaypost': minor
---

The MCP tools `ask_for_permission` and `ask_for_permission_in_background` are now `ask_user` and `ask_user_async`, since they ask any question, not just for permission. Update permission rules and prompts that name the old tools. The MCP server also sends instructions saying when to use each tool, and the Claude Code plugin adds a `jaypost:phone` skill on writing questions and notices for the phone.
