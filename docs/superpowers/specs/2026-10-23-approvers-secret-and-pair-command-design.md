# Approvers from a secret, and `jaypost pair approver`

Builds on `2026-10-22-multiple-approvers-design.md`, which shipped in 0.9.0.

## Intent

Two problems with approvers as shipped:

1. Approver ids go on the command line (`-u 111 -u 222`), so anyone who can read the workflow file sees them. The user doesn't want people other than devops to see them. The earlier spec called them not secret; that's reversed here. Because anyone who can read the workflow file can also read the run logs (public repo: everyone; private repo: everyone with read access), hiding them from the workflow file alone doesn't help. They have to stay out of the logs too.
2. Approvers are paired by a loop at the end of `setup-ci`, plus `setup-ci --approvers-only` to add more later. The user wants a dedicated `jaypost pair approver` command instead.

How it's used in practice (from the user): devops runs the pairing, usually for one or two people at a time, and keeps the full list somewhere outside GitHub. GitHub secrets are write-only, so the list can't be read back from there.

## Goals

- Approver ids can come from a GitHub secret. Different steps can use different secrets (prod approvers vs staging approvers, say).
- Approver ids don't show up in run logs when jaypost runs under GitHub Actions.
- The GitHub Action (`uses: bithyte/jaypost@v0`) supports votes: approvers, `require` and `retry` inputs.
- `jaypost pair approver` pairs one or more approvers in a single run and prints their ids ready to add to the list.
- `pair` is a parent command, so `jaypost pair owner` (or a bare `jaypost pair`) can be added later without breaking `jaypost pair approver`.
- `setup-ci` goes back to pairing only the owner.

## Non-goals

- Storing approvers anywhere, or reading/merging the existing list. Devops keeps it.
- `jaypost pair owner` or any other `pair` subcommand. Only the structure that allows them.
- Service mode support for approvers (still direct mode only, as before).
- Changing how votes decide, retry, or report. All of that stays as in the 0.9.0 spec.

## Anti-goals

- A gate that passes when it shouldn't. In particular, a missing or misnamed secret must not silently turn a vote into a plain question to the owner.
- Approver ids leaking into run logs under GitHub Actions.
- Changing plain `send request` (no approvers, no `--require`, no `--retry`) in either mode, or the Action's behavior for workflows that don't use the new inputs.

## How it behaves

### `JAYPOST_APPROVERS`

- New env var, read in direct mode. It holds approver ids separated by commas and/or whitespace (`111,222,333`, `111 222`, `111, 222`). Empty entries from stray separators are dropped. Duplicates count once, as with `-u`.
- The name is fixed. Each step picks its secret by mapping it in:

  ```yaml
  - run: npx jaypost send request 'Deploy prod?' -o Yes -d No --require majority
    env:
      JAYPOST_APPROVERS: ${{ secrets.PROD_APPROVERS }}
      # plus JAYPOST_MODE, JAYPOST_PROVIDER, JAYPOST_BOT_TOKEN, JAYPOST_OWNER_ID
  ```

- Setting it means "these are the voters", exactly like passing those ids with `-u`. It makes the question a vote, `--require` defaults to `all`, and the vote rules (one `-o`, a different `-d`, no `--allow-text`) apply.
- `-u` beats the env var (user's decision: "what is seen > unseen"). If any `-u` is given, `JAYPOST_APPROVERS` is ignored entirely, not merged. This matches the CLI's flag, then env, then default order.
- My call, fail closed: `JAYPOST_APPROVERS` present but empty (or only separators) is an error, not "no approvers". In GitHub Actions a misspelled or missing secret expands to an empty string, and treating that as unset would send a plain question to the owner, which passes on one yes. Exit 2, with a message saying the var is set but has no ids (and that a missing secret looks like this). Only when `-u` isn't given, since `-u` makes the env var irrelevant.
- An id that the provider's owner setting can't parse fails before anything is sent, as with `-u` today. The error keeps naming the id (`invalid user id "<raw>"`); under Actions it shows as `***` because masks go out before validation (see masking).
- My call: `JAYPOST_APPROVERS` only affects `send request`. `send notify` ignores it (it always goes to the owner), so a job-level env shared by notify steps doesn't break them. A `send request` step that inherits a non-empty job-level value becomes a vote, and an empty one is the error above; both fail closed.
- My call: in service mode, `JAYPOST_APPROVERS` being present is the same bad-arguments error (exit 2) as `-u` there, for the same reason (a silently ignored approver list falls back to the owner alone).

### Masking ids in GitHub Actions logs

- When `GITHUB_ACTIONS=true`, before any output that could include an id (and before validating ids), jaypost emits a mask workflow command (`::add-mask::<id>`) for every voter id, whether it came from `-u` or `JAYPOST_APPROVERS`. It masks each raw entry as given and, if different, its normalized form (`0111` and `111`). After that the runner replaces each id with `***` anywhere in the log: the `--json` `votes` map, error messages naming a voter, anything else.
- Masking ids from `-u` too is my call. They're already in the workflow file, but masking them costs nothing and keeps one rule.
- GitHub already masks the whole secret value, but not the individual ids inside a list, which is why each id needs its own mask.
- Mask commands must not end up in what scripts capture. `answer=$(npx jaypost send request ...)` and the Action's `answer` output must stay exactly the decided answer (or the JSON). See left to the builder for where they go.
- Error messages that name an id, including the bad-id parse error, still name it (they're useful in a local shell). Under Actions they show `***`.
- Outside GitHub Actions nothing changes.

### The GitHub Action

New inputs:

| Input       | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `approvers` | approver ids, comma or space separated (from a secret)             |
| `require`   | `all` or `majority` (request)                                      |
| `retry`     | re-ask up to N times after a timeout, 0 to 100 (request)           |

- `approvers` maps to `JAYPOST_APPROVERS`, so the Action gets the same parsing and masking as the CLI. Not to `-u`, which would put the ids on the command line.
- My call: the `approvers` input is the Action's only source of approvers. `action.yml` always maps it into the step env (overriding any job-level `JAYPOST_APPROVERS`), and `run.sh` unsets the var when the input is empty.
- A GitHub Action can't tell "input not given" from "input given but empty", so the Action can't use the CLI's "present but empty is an error" rule. Instead `approvers` and `require` go together (user's decision): every vote step in the Action must set `require`. Non-empty `approvers` without `require` is exit 2, and `require` with empty `approvers` is exit 2 (in a workflow that almost always means a missing or misnamed secret). So a missing secret fails the step instead of sending a plain question to the owner. This differs from the CLI, where `-u` defaults `--require` to `all` and `--require` without approvers is a vote of one (the owner); neither shortcut is available in the Action. The error messages say which input is missing and, for empty `approvers`, that a missing secret looks like this.
- `approvers`, `require` and `retry` only apply to `command: request`. Using them with `notify` is exit 2, like the other request-only inputs.
- `retry` without `approvers` or `require` re-asks a plain question, as the CLI does.
- The vote rules apply: `options` must be exactly one line, different from `default`, and `allow-text` not true. The binary already checks this, so `run.sh` can pass it through, as long as the error is readable in the step log.
- `answer` output and exit codes are unchanged: 0 approved, 3 rejected, 1 error or cancel, 2 bad input.

Example:

```yaml
- uses: bithyte/jaypost@v0
  with:
    text: Deploy ${{ github.ref_name }} to prod?
    options: 'Yes'
    default: 'No'
    approvers: ${{ secrets.PROD_APPROVERS }}
    require: majority
    retry: 5
    provider: ${{ secrets.JAYPOST_PROVIDER }}
    bot-token: ${{ secrets.JAYPOST_BOT_TOKEN }}
    owner-id: ${{ secrets.JAYPOST_OWNER_ID }}
```

### `jaypost pair approver`

```
jaypost pair approver [--provider NAME]
```

- Asks for the provider and its settings the same way `setup-ci` does today, checks the credentials, starts the bot once, and pairs approvers. It doesn't pair or need the owner.
- It pairs one approver straight away: prints a fresh single-use code and the provider's approver instructions (`approverPairingInstructions`, falling back to `pairingInstructions`, as now), and waits. Same wrong-guess limit as today.
- After each attempt (paired or blocked) it asks `Pair another?` (default no). Each yes gets a fresh code. That's the user's "one or more" answer: several in one run, one at a time, no `--count` flag (one or two people at a time doesn't need one).
- Each id prints as soon as that person pairs (`Approver paired: 111`), as `setup-ci` does now.
- At the end it prints the ids paired in this run as a comma list, labeled as something to add to the approvers list and the secret, and mentions they also work as `-u` flags. It knows nothing of the existing list, so it doesn't claim to print the full one.
- Exit codes and interrupts as the `setup-ci` approver loop has them now: 0 when done (including when nobody paired, since each failure was already reported), 1 on a provider failure (after printing the ids so far), 130 on Ctrl-C (after printing the ids so far). Error text is shown with secrets masked, as in `setup-ci`.
- Providers without pairing (the terminal provider) fail with a message saying they have no approvers to pair, as `--approvers-only` does today.
- `jaypost pair` with no subcommand shows the help listing `approver`. Its exact exit code is the builder's.

### `setup-ci`

- Drops the `Pair an approver?` loop and the `--approvers-only` flag (user's decision: remove it, no deprecation). An unknown option is then a normal commander error.
- After the env var block it prints one line pointing to `jaypost pair approver` for adding approvers.
- Otherwise unchanged: same prompts, env var block, exit codes.

## Constraints

- Repo conventions as in the existing specs: no semicolons, single quotes, width 100, `vp test` and `vp check` pass. Follow the code style already in `src/commands/` and `src/direct/`.
- The pairing logic currently inside `src/commands/setup-ci.ts` (`createPairingWaiter`, the approver loop, `printApprovers`) is what `pair approver` needs. It moves to where both commands can use it rather than being copied.
- Docs: `docs/ci.md` (setup-ci section, Action inputs table, Several approvers section with the secret and masking), `docs/commands.md` (setup-ci usage line, new `pair approver` entry), `docs/scripts.md` (`JAYPOST_APPROVERS` next to `-u`), the README usage lines if they list commands.
- Changesets: one for `JAYPOST_APPROVERS` + masking + the Action inputs, one for `pair approver` + the `setup-ci` change. The `--approvers-only` removal is breaking and the changeset should say so, with `jaypost pair approver` as the replacement. Version bump level follows how the repo has handled breaking changes pre-1.0 (0.8.0 shipped a breaking rename as a minor).

## Left to the builder

- Where the mask commands go so they never reach captured stdout. Stderr is the obvious candidate, but check that the Actions runner processes workflow commands written to stderr before relying on it. In the Action, `run.sh` captures the binary's stdout into a file, so it can also emit the masks itself before running the binary; either way the CLI path (`run:` steps) has to be covered by jaypost itself.
- Exact copy for the new error messages, the `setup-ci` pointer line, `Pair another?` and the final comma-list block.
- Whether the env parsing lives in `src/direct/config.ts` (next to the other `JAYPOST_*` vars) or in the send command. It has to run after `-u` is known, since `-u` makes it irrelevant.
- Where the shared pairing code goes and what it's called.
- Whether `run.sh` validates `require` and `retry` values itself or leaves it to the binary.
