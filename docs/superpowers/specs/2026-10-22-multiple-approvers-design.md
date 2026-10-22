# Multiple approvers design

Builds on `2026-10-22-direct-mode-design.md`, which listed "more than one voter" as a likely follow-up.

## Intent

Direct mode (`JAYPOST_MODE=direct`) made jaypost a CI gate: a workflow step asks the owner "Deploy?" and exits 3 on a No or a timeout. A real deploy gate often needs more than one person. The example from the conversation: a project has 3 owners and they want a release to go out only when all of them (or a majority) say yes.

Today direct mode has exactly one voter, `JAYPOST_OWNER_ID`, paired by `setup-ci`. Everything that sends or accepts answers assumes that one person: the Telegram adapter sends to the owner's chat (`requireOwnerChatId`, src/telegram/adapter.ts:118), Discord opens the owner's DM (src/discord/messenger.ts:41-51), and `OwnerConversation` only accepts taps from the owner (src/conversation/conversation.ts).

The feature is three things that go together:

1. **Approvers**: people who pair with the bot in `setup-ci` like the owner does, but aren't the owner.
2. **Votes**: one question sent to a list of approvers, decided by a rule (`all` or `majority`).
3. **Retries**: re-ask after a timeout, up to N times, only to the people who haven't answered.

The workflow step from the conversation:

```
jaypost send request "Deploy?" -o Yes -d No --require majority --retry 10 -u 111 -u 222 -u 333
```

It waits until the rule is met or can't be met anymore, and the exit code tells the workflow whether to continue.

## Goals

- `setup-ci` can pair approvers as well as the owner, and prints their ids for use with `-u`.
- In direct mode, `send request` accepts `-u <id>` (repeatable) to send the question to those people instead of the owner.
- `--require all|majority` decides the outcome from the votes. The user picked `--require` over `--decision-type` (the name used in the conversation). It leaves room for a threshold like `--require 2` later.
- `--retry N` re-asks after a timeout, up to N more rounds, only to voters who haven't answered. Votes from earlier rounds carry over.
- Exit codes carry the decision and `--json` prints the tally.
- The vote logic lives in the approval core that direct mode already runs in-process (src/direct/session.ts uses `ApprovalService`), so service mode, HTTP, MCP and the Node client can use it later without a rework.

## Non-goals

- Service mode. `-u`, `--require` and `--retry` are direct-mode only for now. No approver storage in config.json, no owner chat commands for approvers, no audit of votes, no restart recovery for votes.
- HTTP API, MCP tools and the Node client.
- Quorum rules beyond the two named ones (thresholds like "2 of 5", weighted votes, vetoes).
- The terminal provider. It's a single-keyboard dev provider.
- Protecting against two CI runs using the same bot at once (already a non-goal of direct mode).
- An env var for the approver list. The ids go on the command line with `-u`, which is what the user asked for; they aren't secrets.

## Anti-goals

- A gate that passes when it shouldn't. Anything misconfigured or misunderstood must fail closed: a bad id, a send that fails for one voter, the flags used in service mode. None of these may exit 0.
- Taps from people who aren't voters on that question counting.
- Changing plain `send request` (no `-u`, no `--require`, no `--retry`) in either mode. Its output and exit codes stay exactly as they are.
- Breaking the existing direct-mode env vars or setup-ci output. Existing workflows keep working untouched.

## How it behaves

### Pairing approvers in `setup-ci`

- After the owner pairs, `setup-ci` asks whether to pair an approver. Each yes prints a fresh pairing code, the approver sends it to the bot the same way the owner did (`/start CODE` on Telegram; on Discord, join through the invite link and DM the bare code), and `setup-ci` records their id. Repeat until the user says no.
- Each approver code is single-use, with the same wrong-guess limit as owner pairing (src/pairing/pairing.ts).
- The output keeps today's env var block unchanged, then adds the approver ids as a ready-to-paste `-u` fragment, something like:

  ```
  Approvers (pass to send request):
  -u 111 -u 222 -u 333
  ```

- My call: `setup-ci --approvers-only` skips the owner and only pairs approvers (it still asks for the provider and bot token), so a team can add someone later without redoing the owner. It prints just the approver block.
- My call on output timing: the env var block is printed as soon as the owner pairs, before the approver questions, so a failure later never loses it. Each approver's id is printed as they pair, and the `-u` fragment at the end. If an approver code gets blocked by wrong guesses, `setup-ci` says so and asks whether to pair another. Ctrl-C while waiting for an approver prints the `-u` fragment for those paired so far and exits 130. A provider fatal error prints the fragment so far and exits 1.
- On Discord, approvers must share a server with the bot before they can DM it. My call: `setup-ci` doesn't create server invites. It tells the user to invite each approver to the server the bot was added to (a normal Discord invite) before giving them the code. Telegram needs nothing extra.
- The owner can be a voter by listing their id with `-u`. They don't pair a second time.
- Pairing is how an approver "meets" the bot: a Telegram bot can only DM users who've started a chat with it, and a Discord bot needs a shared server. It also tells everyone the right numeric id. There's nowhere to store approvers in direct mode, so nothing checks later that an id was paired. A wrong or never-paired id shows up as a failed send (below).

### Sending a vote

- `-u <id>` repeats once per voter, and the question goes to each listed id as a DM instead of to the owner. Duplicate ids count once.
- An id that the provider's owner setting can't parse (not a valid Telegram or Discord user id) fails before anything is sent. Exit 1 or 2 is the builder's call: the provider comes from env, and config errors exit 1 today.
- If sending to any voter fails (never started the bot, blocked it, wrong id), the whole vote fails: messages already sent to others get the cancelled line, and the command exits 1 naming the id that failed. A gate with a voter who can't be reached is a misconfigured gate.
- `JAYPOST_OWNER_ID` stays required in direct mode, even with `-u` (my call: no change to `loadDirectConfig`, and setup-ci always produces it).
- A question is a vote when `-u` or `--require` is given. `--retry` alone doesn't make it a vote.
- `--require` without `-u`: the owner is the only voter, a vote of one. The user was explicit that this isn't an error.
- `-u` without `--require` means `--require all` (my call: the stricter rule, fitting the fail-closed anti-goal).
- My call: `--retry` on a plain question (no `-u`, no `--require`) re-asks the owner on timeout with the same options, `--allow-text` and all, and otherwise behaves exactly like today's direct-mode question: same validation, exit codes and two-field `--json`. Retrying is one mechanism that both plain questions and votes use.
- A vote is a two-way choice: the single `-o` is approve and `-d` is reject (and the timeout answer, as today). More than one `-o`, or `--allow-text`, together with `-u` or `--require` is a bad-arguments error (exit 2). That keeps "majority of what?" from coming up.
- `--project`, `--format`, `--attach` work as they do today and go to every voter.
- In service mode (`JAYPOST_MODE` unset or `service`), `-u`, `--require` and `--retry` are a bad-arguments error (exit 2) saying they need direct mode. They must not be silently ignored: a gate that falls back to asking only the owner would pass with a single yes.

### Deciding

- `all`: approved when every voter has answered `-o`. Rejected as soon as anyone answers `-d`.
- `majority`: approved when more than half of all listed voters answered `-o` (2 of 3, 3 of 4, 1 of 1), not half of those who answered. Rejected as soon as that can no longer happen. With an even count, a tie is a rejection.
- Voting stops as soon as the outcome is certain. My call: every open message is then edited to show the result and stops accepting taps, the same way a finished question is finalized today.
- My call: each voter's message is updated as votes come in, showing who voted what. Names where the provider gives them with the tap, ids otherwise.
- A vote can't be changed. A tap on a message that's already been answered or settled gets the existing "Expired" reply.
- Only taps from the user a message was sent to count for that message. Approvers' typed messages and anything from people who aren't voters are ignored, the same way direct mode ignores non-owners today.

### Retries

- Round 1 goes to all voters with the normal timeout (`--timeout`, default as today).
- When a round times out without a decision, the next round goes only to voters who haven't voted. Earlier votes stand. Each round uses the same timeout. `--retry 10` means up to 11 rounds.
- My call: when a voter is re-asked, their previous message is finalized with a "re-asked" line and stops accepting taps. Only the newest message counts.
- After the last round times out, every missing vote counts as `-d`. Because both rules count all listed voters and stop early once approval is reached, a vote that runs out of rounds is always a rejection (exit 3). Approval never depends on how few people answered.
- SIGINT or SIGTERM (a cancelled workflow run) cancels the vote: all open messages get the cancelled line and the command exits 1, as direct mode does today.
- A GitHub Actions job is killed at its own timeout (6 hours by default). That's a SIGTERM like any cancel; the builder may also want `--retry` × `--timeout` capped or warned about (see left to the builder).

### What the workflow gets

The same codes direct mode already uses, extended to votes:

| Exit | Meaning |
| --- | --- |
| 0 | Approved |
| 1 | jaypost failed, or the vote was cancelled |
| 2 | Bad arguments |
| 3 | Rejected, including missing votes that fell to `-d` after the last round |

Stdout prints the decided answer (`Yes` or `No`). `--json` prints the tally, roughly:

```json
{
  "answer": "Yes",
  "timedOut": false,
  "approved": true,
  "require": "majority",
  "votes": { "111": "Yes", "222": "Yes", "333": null },
  "rounds": 2
}
```

`null` is a voter who never answered (before falling to `-d`). `timedOut` is true when the last round timed out, which always comes with `approved: false`. Field names are the builder's, but keep `answer` and `timedOut` because today's `--json` has them, and keep the existing two-field output for plain requests.

## How it works (decided parts)

- The vote, its rounds and its tally live in the approval layer, next to `ApprovalService`, not in the CLI command. Direct mode drives it through `DirectSession` (src/direct/session.ts) like it drives single questions today. Service mode can expose it later through the same code.
- The rule itself (voters, votes so far, `--require` value → approved, rejected or undecided) is a pure function with no I/O, so it's easy to test exhaustively.
- Sending needs a recipient. Today `Messenger.sendRequest` (src/approval/types.ts) and the provider runtimes always send to the owner. They need to take the user to send to, with the owner as the default so existing callers don't change.
- Answers need a recipient check. `OwnerConversation` accepts taps only from the owner; for a vote message it must accept taps only from the user that message went to. Owner-only rules (commands, plain questions) stay as they are.

## Constraints

- Telegram callback data is at most 64 bytes. Button payloads stay `<id>:<optionIndex>` with a UUID id (see 2026-10-21-owner-conversation-design.md). Each voter's message can have its own id or share one; either way the payload has to fit.
- Telegram and Discord rate limits: a vote sends one message per voter per round, plus an edit per voter whenever a vote comes in. Fine for a handful of approvers; the builder should keep edits to what's needed.
- Direct mode clears the bot's commands when a session starts (README "CI (GitHub Actions)"); nothing here changes that.
- Repo conventions as in the existing specs: no semicolons, single quotes, width 100, `vp test` and `vp check` pass.
- README ("CI (GitHub Actions)", "From the shell" and the usage lines) documents the new flags, the vote exit codes, approver pairing in `setup-ci` and `--approvers-only`.

## Left to the builder

- Exact flag spellings. `--require` is decided. The conversation used `-retry` and `-u`; the CLI uses `parseArgs` long flags, so `--retry` and `-u`/`--user` (or `--approver`) are the obvious fit.
- Exact `setup-ci` prompt wording and output layout, following what it prints today.
- Exact copy for the vote progress line, "re-asked", and the settled result on each message.
- The `--retry` upper limit, and whether to cap or warn on total wait (rounds × timeout).
- Whether a vote is one record with many messages or many linked requests inside the approval layer.
