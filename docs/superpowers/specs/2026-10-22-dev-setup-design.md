# Contributor dev setup design

Status: round 1 (terminal provider, `pnpm dev`, README section) and round 2 (pick the provider in `pnpm dev` and reuse init's bot token flow) are built on `cozmin/feat-dex` (DX, developer experience). This spec records what was asked, what was decided and what was built.

## Intent

Someone clones jaypost and wants to run it locally and change a line of code. Before this work there was no contributor section in the README. The path had to be pieced together: install Vite+ (`vp`) globally (only mentioned under "Releasing"), make a Telegram or Discord bot, get a config in place without running `init` (which installs a real background service), and work out port and config clashes with any jaypost install already on the machine.

The owner's words: "people don't have time for this hassle. we need 2-3 commands TOPS and the collaborator to be able to modify his first line of code."

Round 2: after round 1, trying a real bot still meant `cp .env.example .env` and editing it by hand. The owner asked to change a step of the prod setup so the dev setup can reuse it. The step is init's "which chat app, then bot token, checked and asked again until it works" flow. In dev it should offer the prod providers plus the terminal provider.

Success: after `git clone`, a contributor runs `pnpm install` and `pnpm dev`, picks Terminal (or a real bot and pastes its token), sees a question appear, answers it, edits a source file and sees the service restart with the change.

## Goals

- Two or three commands from clone to a running service.
- No bot token, account, config file or phone needed to try the service locally.
- Saving a source file restarts the service.
- A local dev run never touches a real jaypost install on the same machine: different port, separate config, state and question log.
- A short, findable README section that says all of the above.
- Round 2: `pnpm dev` asks which provider to use (Telegram, Discord, Terminal) on every run, with the last choice preselected. For Telegram and Discord it runs init's own bot token flow: reuse a saved token that still checks out, else ask, check, ask again.
- Round 2: that flow is one piece of code shared by `init` and `pnpm dev`, not a copy.

## Non-goals

- Changing how users install or run jaypost. `init`, the install targets and the published package behave as before. Round 2 refactors init's code but not its behavior.
- A mock of Telegram's or Discord's UI. The terminal provider is plain text.
- Windows support for the dev script (not checked either way).
- A site (`site/`) dev workflow. `vp run web:dev` already exists and is documented under "Releasing".
- Round 2: running the rest of init in dev (target choice, install, API token).

## Anti-goals

- Users ever being offered the terminal provider in `init`.
- `pnpm dev` writing into `~/.config/jaypost` or binding 8787 by default.
- Requiring a global `vp` install for contributors.
- Round 2: `pnpm dev` asking again on every file save. The prompts run once per `pnpm dev`, in the parent, before the watcher starts.
- Round 2: dev-only branches inside `runInit`'s flow.

## Decided by the owner

- 2-3 commands at most; the contributor must be able to edit code right away.
- Approved the proposal: a built-in terminal provider for keyless local runs, `pnpm dev` in watch mode with isolated state, optional `.env` for a real bot, a README "Contributing" section.
- Round 2: reuse init's provider and bot token flow in `pnpm dev`. The provider is selectable: the prod providers plus Terminal.
- Round 2: approach "A": pull the provider and settings step out of `runInit` into exported code. `runInit` calls it with `PROVIDERS` and `scripts/dev.ts` calls it with `SERVICE_PROVIDERS`. (Rejected: a `dev` install target, a hidden `dev-setup` command, an `init --dev` flag, and reusing only the provider pieces without touching init.)
- Round 2: ask every run, with the last choice preselected.
- Round 2: a `BOT_TOKEN` in `.env` or the shell skips the prompts (the owner confirmed this call).

## Decided by me (owner can override)

### Round 1 (built)

- **Terminal provider** in `src/terminal/`, registered only for the service, not for `init`. `PROVIDERS` (what `init` offers and the install code uses) stays `[telegram, discord]`. A new `SERVICE_PROVIDERS` adds `terminalProvider`, and `loadConfig` defaults to it, so `PROVIDER=terminal` works anywhere a config is loaded.
- **Terminal provider behavior:**
  - No settings, so no token and no pairing. `checkCredentials` always succeeds with display name `terminal`.
  - Questions are numbered from 1 per run and printed as `#N <text>`, then `1) A   2) B`, plus `(or type a reply)` when text is allowed and `attached: <name> (<n> bytes)` for an attachment.
  - Input is one line per answer. A bare line answers the only open question. With several open, a `#N` prefix is required (`#2 1`). An option number in range answers with that option; anything else is a reply if the question allows text, else an error naming the valid range.
  - Lines starting with `/` run owner commands (`/pending`, `/cancel`, ...). An unknown command lists the known ones.
  - `finalize` prints `#N answered: X`, `timed out: X`, `rejected: X`, `replied: X`, `cancelled` or `expired`. The saved reference is `{ number, id }` so a previous run's question, expired on restart, can't close a new question that reuses the number.
  - Notifications print `notification: <text>`. No `deleteMessage`, so no dismiss and no expiry.
  - Max text length 4096; attachments up to `MAX_ATTACHMENT_BYTES`, so attachment code paths can be exercised.
- **`pnpm dev`** runs `scripts/dev.ts`, which:
  - loads `.env` from the repo root if present (existing env vars win);
  - sets `JAYPOST_CONFIG=.dev/config.json` and `PORT=8788` unless already set;
  - sets `PROVIDER=terminal` unless `PROVIDER` or `BOT_TOKEN` is set;
  - prints `try it from another terminal: pnpm cli test --port 8788`;
  - spawns `node --watch src/cli.ts start` with inherited stdio and waits for it on Ctrl+C.
  Round 2 changes the config path and the provider steps; see below.
- **Real bot route:** `.env.example` (committed) with `BOT_TOKEN=` and a commented `PROVIDER=discord`. The contributor copies it to `.env` (already gitignored). Pairing then works as usual. Round 2 keeps this route as the non-interactive alternative.
- **`.dev/`** is gitignored.
- **`pnpm cli` doesn't target the dev port by default.** Forcing `PORT=8788` on every CLI command would make `pnpm cli init` install a real service on 8788. The hint and README pass `--port 8788` explicitly instead.
- **`jaypost test --port N`** was added, because `test` was the only client command without `--port` and the README hint failed with `unknown option '--port'`. The flag wins over everything. Without it, `test` keeps its existing order (the install's port, then config/`PORT`, then 8787), which is covered by an existing test. Patch changeset in `.changeset/test-port.md`.
- **README "Contributing" section**, placed before "Releasing": prerequisites (Node 24+, any recent pnpm), `pnpm install` and `pnpm dev`, how to answer in the terminal, `pnpm cli test --port 8788`, the `.env` route, and "run `pnpm test` and `pnpm check` before a PR; add a changeset if users would notice".
- **No CONTRIBUTING.md**; the README already holds all docs.

### Round 2 (built)

#### The `pnpm dev` flow

`scripts/dev.ts` does this once per run, before it spawns the watcher:

1. Load `.env` as now. If `PROVIDER` or `BOT_TOKEN` is set (shell or `.env`), skip steps 2 to 5 and behave as round 1 does today, with the config path from step 5's layout for that provider (`PROVIDER`, else `DEFAULT_PROVIDER`). The owner decided `BOT_TOKEN` skips; also skipping on `PROVIDER` is my call, since it's the same rule round 1 uses and an explicit choice shouldn't be asked again.
   If `JAYPOST_CONFIG` is set, it also skips steps 2 to 5 and the service uses that file as is. Dev never writes to it. (My call. Writing the chosen provider and token into a file the shell points at could overwrite a real install's config, and honoring it on the prompt path would put every provider back into one file.) The README says so in one line.
2. Read the last choice from `.dev/dev.json` (`{ "provider": "<name>" }`). Missing file, a corrupt file or a name not in `SERVICE_PROVIDERS` all mean "no last choice". Use Terminal then.
3. Ask "Which chat app should the bot use?" over `SERVICE_PROVIDERS` (labels Telegram, Discord, Terminal), with the last choice preselected. This is init's `chooseProvider` select, same text.
4. Settings for the chosen provider come from the shared settings step (below), seeded with what that provider's dev config file already holds. Telegram and Discord: a saved token that passes `checkCredentials` is reused with the provider's `text.reusing(displayName)` ("Reusing the saved bot token (@x)."). Otherwise the token is asked for with the provider's own prompt and password input, checked, and `text.rejected` is printed before asking again. Terminal: nothing is asked.
5. Write the chosen provider and settings into `.dev/<provider>/config.json`. Then write `.dev/dev.json` with the chosen provider. Then spawn `node --watch src/cli.ts start` with `JAYPOST_CONFIG=.dev/<provider>/config.json`, `PORT=8788` (unless set) and `PROVIDER=<provider>`.

Steps 2 to 5 replace round 1's "default to `PROVIDER=terminal`" rule.

#### One config directory per provider (my call)

Telegram and Discord both use the config keys `botToken` and `ownerId`. With a single `.dev/config.json`, switching from Telegram to Discord would offer a Telegram token to Discord and keep a Telegram owner id. Switching to Terminal and back would lose the token, because init's write nulls other providers' keys. Init handles a switch by clearing the owner and asking again. That's fine for a one-off install but bad for someone who flips between Terminal and Telegram every run.

So each provider gets its own directory: `.dev/telegram/`, `.dev/discord/`, `.dev/terminal/`. Each holds its own `config.json`, and because state and the question log sit next to the config (`resolveStatePath`, `resolveAuditPath`), those are per provider too. Switching never loses a token or a pairing, and each provider's file only ever holds that provider's settings. The cost is that a contributor's round 1 `.dev/config.json` is ignored after the upgrade. Nobody outside this branch has one, so there's no migration.

#### The shared code in `src/commands/`

Init's flow today is: choose provider, handle an existing install (which needs the provider to decide what to read and clear), then reuse or prompt for settings. The provider select and the settings step are split by install-only logic, so they come out as two pieces, not one:

- **Provider select:** today's `chooseProvider`, taking the provider list and the preselected name as inputs instead of reading `deps.providers` and the install record. `runInit` passes `deps.providers` (which is `PROVIDERS` in `cli.ts`) and the existing install's provider. Dev passes `SERVICE_PROVIDERS` and the last choice. The `--provider` flag and the "only one registered, don't ask" rule stay as they are.
- **Settings step:** today's block in `runInitInner` from "reuse saved settings if complete and `checkCredentials` passes" through the prompt/retry `while` loop, as one function. Inputs: provider, saved settings, prompts, print, abort signal, and somewhere to push secret values seen (init's `seen` array, used to mask error text). Result: the settings, or "rejected" for the case where the provider has nothing to prompt and its saved settings don't pass (init returns 1 there today).
- **Empty settings fix:** a provider that declares no settings at all (Terminal) is accepted with empty settings when `checkCredentials({})` passes, without printing `text.reusing`. Today that case falls to "rejected", because the reuse check deliberately skips an empty settings bag. Providers that declare settings must behave exactly as they do now, including the `some` check that stops an all-optional provider from reusing an empty bag.
- Both pieces are exported through `src/commands/index.ts` so `scripts/dev.ts` can import them. Init's prompt texts don't change.
- Dev writes its config with `updateConfigFile` (exported from `src/config/`) and reads saved settings with `readConfigFile` + `collectSettings` (exported from `src/config/` and `src/provider/`). `readConfigSecrets` and `writeServiceConfig` in `src/install/native.ts` aren't exported from `src/install/index.ts`, and `readConfigSecrets` reports `telegram` for a missing file, so dev doesn't use them. A missing `.dev/<provider>/config.json` means no saved settings. Dev writes no `apiToken`: the dev service runs without API auth, as in round 1.

#### Edge cases (my calls)

- **Not a TTY** (piped stdin, CI): the clack prompts refuse a non-TTY stdin (`PromptAborted`). Dev doesn't call them. It uses the last choice (or Terminal) and the saved settings. If that provider needs a token and none valid is saved, it exits 1 with a message saying to run `pnpm dev` in a terminal or set `BOT_TOKEN`.
- **Ctrl+C during a prompt:** exit 130, start nothing, write nothing.
- **Token check fails because the network is down:** same as init, it prints `text.rejected` and asks again. Ctrl+C gets out.
- **Pairing:** the service already logs `Not paired. <instructions>` with the code when the owner is missing, and the dev terminal shows the service's output, so dev doesn't run init's `waitForPairing` on top. (In the playback I said dev would reuse `waitForPairing`. I dropped that after finding the service log; it would print the code twice.)
- **Stdin hand-off:** the prompts must be fully closed before the watcher is spawned, so the terminal provider gets stdin to itself.

#### README

Update "Contributing": `pnpm dev` asks which chat app to use. Terminal needs nothing. Telegram or Discord asks for your own bot's token once, then reuses it and prints a pairing code the first time. The `.env` route stays as the way to skip the questions. Keep "use your own bot, not one a running install already uses".

#### Tests

- The extracted settings step and provider select are covered by the existing `runInit` tests, which must pass unchanged. Add tests for the new behavior: a provider with no settings is accepted, and the select preselects the given name over the list's first entry.
- `scripts/dev.ts` has no tests today. Testing the dev flow through a spawned script with a fake TTY is more than it's worth, so it gets a manual check (below). The builder can add a test if they find a cheap seam.
- Follow the repo's existing style in `src/commands/` (plain exported functions, injected `deps`), not the class layout in the global TypeScript rules. The nearest code wins.

## Constraints

- Node 24+, pnpm pinned to 12.14.0 via `packageManager`. Package scripts call `vp`, which resolves to the local `vite-plus` devDependency, so no global `vp` is needed.
- Only one instance may run per bot token, so a real bot in dev needs the contributor's own bot, not one a running install uses.
- The provider contract in `src/provider/types.ts` is unchanged.
- Round 2: `init`'s behavior, prompt texts and exit codes are unchanged. `PROVIDERS` stays `[telegram, discord]`.

## Verified (round 1)

- Fresh copy of the tree, stock pnpm 10 with no `vp` on `PATH`: `pnpm install` switches itself to pnpm 12 and installs; `pnpm test` passes.
- `pnpm dev` starts on 8788 with the terminal provider. A `send request` was answered by typing `1` (client printed `Yes`), `send notify` printed in the dev terminal, `/pending` replied. `pnpm cli test --port 8788` returned `200 {"answer":"Approve","timedOut":false}`. State and question log landed in `.dev/`.
- Node's `--watch` passes stdin through to the service.
- Full suite, `pnpm check` and `tsc` are clean for the new code. `test/telegram/runtime.test.ts` already had `tsc` errors and still does.

## Not verified (round 1)

- `pnpm dev` with a real Telegram or Discord token.
- Typing into a real interactive TTY (tested through a pipe).
- Windows.

## Verified (round 2)

- Through a pty (`script`): first run preselects Terminal; the service then gets stdin (a typed `1` answered `pnpm cli test --port 8788`, which got `200 {"answer":"Approve","timedOut":false}`); saving a source file restarted it and `/pending` still answered. Picking Telegram with a bad token printed `text.rejected` and asked again; Ctrl+C there exited 130 and wrote nothing.
- Piped stdin: Terminal starts; last choice Telegram with no saved token exits 1 with the message.
- `BOT_TOKEN` in the env skips the prompts and uses `.dev/telegram/config.json`.
- `pnpm test` (init tests unchanged), `pnpm check` and `tsc` clean, apart from the old `test/telegram/runtime.test.ts` errors.

## Not verified (round 2)

- A real Telegram or Discord token: reuse on the next run, the pairing code, and keeping the token and pairing across a switch to Terminal and back.
- A human typing into a real terminal (only a pty driven by a script).

## Files

Round 1:

- `src/terminal/` (`constants.ts`, `types.ts`, `runtime.ts`, `provider.ts`, `index.ts`)
- `src/provider/registry.ts`, `src/provider/index.ts`, `src/config/store.ts` (`SERVICE_PROVIDERS`)
- `src/cli.ts` (`test --port`)
- `scripts/dev.ts`, `package.json` (`dev` script), `.env.example`, `.gitignore`
- `README.md` (Contributing section, `jaypost test [--port N]`)
- `.changeset/test-port.md`
- `test/terminal/runtime.test.ts`, `test/terminal/provider.test.ts`, `test/cli.test.ts`

Round 2:

- `src/commands/provider-setup.ts` (`selectProvider`, `resolveProviderSettings`), `src/commands/init.ts`, `src/commands/index.ts`, `src/commands/types.ts`
- `scripts/dev.ts` (including its header comment, which still says "without a BOT_TOKEN it asks in this terminal")
- `.env.example` (its comment says the same; it becomes "copy to .env to skip the `pnpm dev` questions")
- `README.md` (Contributing)
- `test/commands/provider-setup.test.ts`

Left to the builder: function and file names, how `scripts/dev.ts` builds the prompts and abort signal (`createClackPrompts` as `cli.ts` does), and whether `.dev/dev.json` is read with the config module's JSON reader or a few lines in the script.
