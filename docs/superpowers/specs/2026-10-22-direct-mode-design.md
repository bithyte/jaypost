# Direct mode design

Part 1 of 3. Part 2: `2026-10-22-gh-action-marketplace-design.md`. Part 3: `2026-10-22-gh-action-usage-design.md`.

## Intent

Devops want release workflows to stop and ask one person (the owner, "the boss") before risky steps, and to tell them when something shipped:

```
npx jaypost send request 'Publish v123?' -o Yes -d No
npx jaypost send notify 'New version published'
```

Today `send` only talks to the jaypost service over HTTP on `127.0.0.1:8787`, and the service needs `init`, pairing and a background process. A GitHub Actions runner has none of that. The CLI needs a mode where it talks to the bot itself, reads everything it needs from env vars (GitHub secrets), and exits when it's done.

This part is the CLI only. It's what the GitHub Action (part 2) runs.

## Goals

- `jaypost send request` and `jaypost send notify` work on a CI runner with no `init`, no service and no config file, using only env vars.
- A No or a timeout fails the workflow step.
- A one-time setup command devops run on their laptop that pairs the owner and prints the env vars to paste into GitHub secrets.
- Every env var jaypost reads has the `JAYPOST_` prefix.

## Non-goals

- More than one voter. Out of scope now; it's likely later, so don't shape the env vars in a way that makes adding voters a breaking change.
- Protecting against two CI runs using the same bot at once. Only CI uses the bot; concurrent use is devops' responsibility.
- Quiet hours, mute, the audit log and owner commands (`/cancel`, etc.) in direct mode. Those belong to the long-running service.
- Migrating old env var names.

## Anti-goals

- Changing `send` behaviour for service-mode users beyond the env var rename. With `JAYPOST_MODE` unset, `send` keeps today's output and exit codes.
- Putting secret values on a command line or in logs.

## Decided by the user

### Mode switch

`JAYPOST_MODE=direct|service`. Default `service` (today's behaviour: HTTP to the local service). `direct`: the CLI starts the provider runtime (Telegram or Discord) in-process, sends the message, waits for the answer if it's a request, stops the runtime and exits. Any other value is a usage error (exit 2).

The mode is explicit. It's never inferred from which other env vars are set.

### Exit codes and failure

In `direct` mode, `send request` exits:

- `0`: answered with something other than the `-d` value.
- `1`: error (bad token, network, provider refused, etc.).
- `2`: bad arguments (as today).
- `3`: the answer equals the `-d` value, or the timeout fired. This is what makes the step fail on a No.

The answer is printed to stdout in every case (`--json` too), so a step can still capture it.

`service` mode keeps today's exit codes (0 on any answer). (My call, so existing scripts don't break; the user asked that a No fail in GitHub Actions, which is direct mode.)

`send notify` in direct mode exits 0 once the provider accepts the message, 1 on error.

### One owner

Exactly one owner answers. The owner is whoever paired during `setup-ci`.

### Setup command: `jaypost setup-ci`

Run once on a devops laptop. Interactive, like `init`, but it:

1. Asks for the provider (Telegram or Discord) and the bot token, and checks the token (same check `init` uses).
2. Starts the bot in-process and prints a pairing code plus instructions, the same as `init` does. Devops hands the code to the owner, who sends it to the bot (`/start CODE` on Telegram, a DM of the bare code on Discord, after adding the bot through the invite link).
3. Once paired, stops the bot and prints the env vars, ready to paste into GitHub secrets, then exits.

It installs no service, writes no API token, and doesn't touch `~/.config/jaypost`. (Not writing any files is my call: the output is meant for GitHub secrets, not this machine.)

Output:

```
JAYPOST_MODE=direct
JAYPOST_PROVIDER=telegram
JAYPOST_BOT_TOKEN=...
JAYPOST_OWNER_ID=...
```

### Env var rename

Every env var jaypost reads gets the `JAYPOST_` prefix, in every mode. No migration and no fallback to the old names; older installs have to update their env files themselves.

| Old         | New                 |
| ----------- | ------------------- |
| `PROVIDER`  | `JAYPOST_PROVIDER`  |
| `BOT_TOKEN` | `JAYPOST_BOT_TOKEN` |
| `OWNER_ID`  | `JAYPOST_OWNER_ID`  |
| `PORT`      | `JAYPOST_PORT`      |
| `HOST`      | `JAYPOST_HOST`      |

`JAYPOST_TOKEN` and `JAYPOST_CONFIG` are already prefixed. New: `JAYPOST_MODE`. Standard vars (`HOME`, `XDG_*`, `PATH`, `CLAUDE_PROJECT_DIR`) stay as they are.

`PORT` and `HOST` are included because the user said "everywhere". (My reading.)

Places that read or write these today: `src/config/store.ts`, `src/commands/owner.ts`, `src/mcp/port.ts`, `src/cli.ts`, the providers' `envVar` fields (`src/telegram/provider.ts`, `src/discord/provider.ts`), and the install templates that write `.env` files and units (`src/install/templates.ts`, `quadlet.ts`, `compose.ts`, `envfile.ts`). The README, `docs/openapi.yaml` (if it mentions them) and the website change too.

This breaks existing installs, so the changeset says so plainly, including what to rename in a Quadlet/Compose `.env`.

## Direct-mode behaviour details (my calls)

- Notifications are sent without a Dismiss button and aren't auto-deleted, because no process stays alive to handle the tap or the 8-hour expiry.
- On SIGINT or SIGTERM (a cancelled workflow run), a pending question's message is edited to the "cancelled" line before exit, as `send` does today through the service.
- On timeout, the message is finalized the same way the service finalizes a timed-out request.
- Attachments (`--attach`) work as in service mode, within the provider's limit.
- Settings come only from env vars in direct mode; the config file isn't read.

## Docs

- README: the mode, exit codes, `setup-ci`, the env var rename.
- A GitHub Actions example for `npx` users. jaypost needs Node 24.2+, so it shows `actions/setup-node` with `node-version: 24` before the `npx jaypost send ...` line, and the env vars passed from secrets with `env:` (never on the command line).

## Existing code to build on

- Providers already describe their settings with an env var name and a config key (`src/provider/types.ts`, `ProviderSetting`). On Discord the owner is a user ID; the DM channel is derived from it, so no extra var is needed.
- `Provider.createRuntime(settings, log)` returns a `ProviderRuntime` with `start(handlers)`, `sendRequest`, `finalize`, `sendNotification`, `stop`, and pairing through `handlers.pair`. Direct mode and `setup-ci` should drive this directly instead of going through the HTTP server.
- `init` already does the provider prompt, the credential check and pairing (`src/commands/init.ts`, `src/commands/pairing-*.ts`).
- `send` argument parsing and output stay as they are (`src/commands/send.ts`).

## Left to the builder

- How the in-process runtime is wired (reuse the approval service in memory, or a smaller path).
- Exact wording of `setup-ci` prompts and output, following `init`.
- Tests, following the repo's existing test layout.
- Website updates.
