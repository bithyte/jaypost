---
name: phone
description: Use when about to do something destructive, costly or shared, or stuck on a decision, while the user may be away from the terminal; also when reporting done or blocked, or waiting on a background answer through jaypost's MCP tools.
---

# Reaching the user on their phone

The jaypost tools send a message to the user's phone and, for questions, return their tap or typed reply. The tool descriptions cover the parameters; this covers when to ask, what the plugin already does, and how to write messages that get answered.

## When to ask

Call the tool directly. Don't ask in chat whether to ask, and don't stop for a chat reply while the user is away.

Ask with `ask_user` before a step the permission hook won't catch (it's already allowed, or it isn't a tool call) when it:

- is destructive or hard to undo: deleting files, data or branches, force-pushing, rewriting history, running migrations
- spends money or touches something shared: deploying, publishing, calling a paid API, messaging other people
- picks between options that change what gets built, when the code and the task don't settle it

Don't ask about what you can decide from the code or a sensible default. Pick one and mention it in your report.

Use `notify_user` when no answer is needed: the task is done, you're blocked on something only the user can fix, or a long step finished.

## What the plugin already sends

- Tool permission prompts reach the phone through the plugin's hook. For a tool call that needs permission, make the call and let the prompt ask.
- AskUserQuestion stays in the terminal. While the user is away, ask with `ask_user` instead.
- When you finish a turn and nobody types for a minute, the hook sends your final message to the phone, and the user can reply with the next prompt. Make the start of that message say what got done and what's open.

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
