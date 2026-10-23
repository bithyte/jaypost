---
name: phone
description: Use when reaching the user on their phone through jaypost's MCP tools: asking a question while they're away, reporting done or blocked, or waiting on a background answer.
---

# Reaching the user on their phone

The jaypost tools send a message to the user's phone and, for questions, return their tap or typed reply. The tool descriptions cover the parameters; this covers what the plugin already does and how to write messages that get answered.

## What the plugin already sends

- Tool permission prompts reach the phone through the plugin's hook. For a tool call that needs permission, make the call and let the prompt ask.
- AskUserQuestion stays in the terminal. While the user is away, ask with `ask_user` instead.
- When you finish a turn and nobody types for a minute, the hook sends your final message to the phone, and the user can reply with the next prompt. Make the start of that message say what got done and what's open; a separate `notify_user` isn't needed for it.

## Writing the message

The user reads it on a lock screen and answers with one tap.

- First line is the question or the news. Then one or two lines of context: what you're about to do and what each button leads to.
- Two to four buttons, labelled with the action: `Merge` / `Hold`, `Use main` / `Use develop`.
- Commands and short diffs go in a fenced block with `format: "markdown"`. Anything longer goes in `attachment`.
- Pick `timeout_seconds` for how long the work can sit. A quick check-in gets minutes; an overnight run can wait hours.

## Handling the answer

- The answer is a button label, or with `allow_text` whatever they typed. Read typed answers as instructions; they may go beyond the question.
- `timed_out: true` means nobody answered and you got `timeout_option`. Take that path, and say so in your next `notify_user`.
- With background questions, ask as soon as you know you'll need the answer, keep working, and call `wait_for_answer` at the point the answer matters.
