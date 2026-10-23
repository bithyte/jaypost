# Approvers from a secret, and `jaypost pair approver` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approver ids can come from a GitHub secret through `JAYPOST_APPROVERS`, are masked in Actions logs, work from the GitHub Action, and are paired with a new `jaypost pair approver` command instead of `setup-ci`.

**Architecture:** A small pure module in `src/direct/` turns `-u` flags and `JAYPOST_APPROVERS` into a voter list and formats `::add-mask::` lines. The CLI resolves voters from it before the existing vote validation; `runDirectVote` writes the masks to stderr before touching ids. The pairing plumbing in `setup-ci.ts` moves into a shared `ci-pairing.ts`, used by `setup-ci` (owner only now) and the new `pair approver` command. `action.yml` / `action/run.sh` map the new inputs onto the same env var and flags.

**Tech Stack:** TypeScript on Node, commander, vite-plus (`vp test`, `vp check`), bash for the Action.

**Spec:** `docs/superpowers/specs/2026-10-23-approvers-secret-and-pair-command-design.md` (read it; this plan argues from it). Background: `docs/superpowers/specs/2026-10-22-multiple-approvers-design.md`.

## Global Constraints

- Follow the repo's existing style, not a generic one: plain exported functions (no classes), no semicolons, single quotes, width 100, tests in `vite-plus/test` (`test`, `expect`, `vi`), flat `test('...')` with lowercase behavior names.
- `vp test` and `vp check` pass after every task.
- Env var name is exactly `JAYPOST_APPROVERS`. Separators: commas and/or whitespace; empty entries dropped.
- `-u` beats `JAYPOST_APPROVERS`: any `-u` means the env var is ignored, not merged.
- Present-but-empty `JAYPOST_APPROVERS` (only when no `-u`) on `send request` in direct mode: exit 2.
- `JAYPOST_APPROVERS` present at all on `send request` in service mode: exit 2.
- `send notify` ignores `JAYPOST_APPROVERS` in both modes.
- Masks only when `GITHUB_ACTIONS === 'true'`, written to stderr, never stdout.
- Exit codes unchanged: 0 approved, 1 error or cancel, 2 bad arguments, 3 rejected; pairing commands 0 / 1 / 130.
- No em-dashes anywhere (code, docs, commits). Commits are conventional and lowercase (`feat:`, `refactor:`, `docs:`, `chore:`) with no `Co-Authored-By` trailer.

## Review Focus

1. A multi-line secret (`111\n222`, or `111, 222,`) must parse to the same ids as `111,222`. Pinned in Task 1.
2. A job-level `JAYPOST_APPROVERS: ''` must not break `send notify` steps in the same job. Pinned in Task 2.
3. `-u` together with an empty `JAYPOST_APPROVERS` must run the `-u` vote, not error. Pinned in Task 2.
4. Under Actions, mask lines must never reach stdout, so `answer=$(jaypost send request ...)` stays the bare answer. Pinned in Task 3.
5. An id with padding (` 111`) or a non-canonical form (`0111`) must still be masked in the form the tally prints (`111`). Pinned in Task 3.

---

### Task 1: Approver list and mask lines

**Files:**
- Modify: `src/config/constants.ts`, `src/config/index.ts` (add and export `APPROVERS_ENV_VAR`)
- Create: `src/direct/approvers.ts`
- Modify: `src/direct/types.ts`, `src/direct/constants.ts`, `src/direct/index.ts`
- Test: `test/direct/approvers.test.ts`

**Interfaces:**
- Produces:
  - `APPROVERS_ENV_VAR = 'JAYPOST_APPROVERS'` from `src/config/index.ts`
  - `type ApproverList = { readonly kind: 'listed'; readonly voters: readonly string[] } | { readonly kind: 'empty' } | { readonly kind: 'none' }` in `src/direct/types.ts`, exported as a type from `src/direct/index.ts`
  - `NO_APPROVERS` and `EMPTY_APPROVERS` (`{ kind } as const satisfies ApproverList`) in `src/direct/constants.ts`
  - `resolveApprovers(flagVoters: readonly string[] | undefined, env: NodeJS.ProcessEnv): ApproverList`, never throws
  - `formatMaskCommands(ids: readonly string[], env: NodeJS.ProcessEnv): readonly string[]`, never throws

- [ ] **Step 0: Commit the spec and this plan**

```bash
git add docs/superpowers/specs/2026-10-23-approvers-secret-and-pair-command-design.md docs/superpowers/plans/2026-10-23-approvers-secret-and-pair-command.md
git commit -m "docs: approvers secret and pair approver design and plan"
```

- [ ] **Step 1: Write the failing tests** in `test/direct/approvers.test.ts`, importing from `../../src/direct/index.ts`:

```ts
test('flags win over the env var', () => {
  expect(resolveApprovers(['1'], { JAYPOST_APPROVERS: '2,3' })).toEqual({ kind: 'listed', voters: ['1'] })
  expect(resolveApprovers(['1'], { JAYPOST_APPROVERS: '' })).toEqual({ kind: 'listed', voters: ['1'] })
})
test('reads ids split by commas and whitespace', () => {
  expect(resolveApprovers(undefined, { JAYPOST_APPROVERS: '111, 222,\n333 444,' })).toEqual({
    kind: 'listed',
    voters: ['111', '222', '333', '444'],
  })
})
test('an unset env var means no approvers', () => {
  expect(resolveApprovers(undefined, {})).toEqual({ kind: 'none' })
})
test('a set env var with no ids is empty', () => {
  for (const value of ['', ' ', ' , \n']) {
    expect(resolveApprovers(undefined, { JAYPOST_APPROVERS: value })).toEqual({ kind: 'empty' })
  }
})
test('mask lines under github actions, one per distinct trimmed id', () => {
  expect(formatMaskCommands(['1', ' 2', '1', ''], { GITHUB_ACTIONS: 'true' })).toEqual([
    '::add-mask::1',
    '::add-mask::2',
  ])
})
test('no mask lines outside github actions', () => {
  expect(formatMaskCommands(['1'], {})).toEqual([])
  expect(formatMaskCommands(['1'], { GITHUB_ACTIONS: 'false' })).toEqual([])
})
```

- [ ] **Step 2: Run** `vp test test/direct/approvers.test.ts`. Expected: FAIL, `resolveApprovers` is not exported.

- [ ] **Step 3: Implement** `resolveApprovers` and `formatMaskCommands` in `src/direct/approvers.ts`. Read the raw env value with `env[APPROVERS_ENV_VAR]`, not `findEnvValue`, because empty must stay distinguishable from unset (say so in a `//` comment). Split with `APPROVER_SEPARATOR_PATTERN = /[\s,]+/` from `src/direct/constants.ts`. JSDoc both with "Never throws".

- [ ] **Step 4: Run** `vp test test/direct/approvers.test.ts`. Expected: PASS. Then `vp check`.

- [ ] **Step 5: Commit** `feat: approver list from JAYPOST_APPROVERS and mask lines`

### Task 2: CLI reads `JAYPOST_APPROVERS` for `send request`

**Files:**
- Modify: `src/cli.ts` (the `send request` action, around lines 616-660)
- Test: `test/cli.test.ts` (next to `'vote and retry flags need direct mode'`)

**Interfaces:**
- Consumes: `resolveApprovers`, `APPROVERS_ENV_VAR` (Task 1)

- [ ] **Step 1: Write the failing tests** in `test/cli.test.ts`, using `vi.stubEnv` like the neighboring tests, with stderr spied and `REQUEST_ARGS` reused:

```ts
test('JAYPOST_APPROVERS needs direct mode, even empty', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('JAYPOST_MODE', '')
  for (const value of ['1', '']) {
    vi.stubEnv('JAYPOST_APPROVERS', value)
    expect(await main(REQUEST_ARGS)).toBe(2)
  }
})
test('an empty JAYPOST_APPROVERS exits 2 in direct mode', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('JAYPOST_MODE', 'direct')
  vi.stubEnv('JAYPOST_APPROVERS', ' , ')
  expect(await main(REQUEST_ARGS)).toBe(2)
  const output = stderr.mock.calls.map((call) => String(call[0])).join('')
  expect(output).toContain('JAYPOST_APPROVERS is set but has no ids')
})
test('-u wins over an empty JAYPOST_APPROVERS', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('JAYPOST_MODE', 'direct')
  vi.stubEnv('JAYPOST_APPROVERS', '')
  vi.stubEnv('JAYPOST_BOT_TOKEN', '')
  // 1: got past validation to the direct send, which fails on the missing token
  expect(await main([...REQUEST_ARGS, '-u', '1'])).toBe(1)
})
test('JAYPOST_APPROVERS makes the question a vote', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('JAYPOST_MODE', 'direct')
  vi.stubEnv('JAYPOST_APPROVERS', '1,2')
  const args = ['send', 'request', 'Deploy?', '-o', 'Yes', '-o', 'Maybe', '-d', 'No']
  expect(await main(args)).toBe(2)
})
test('send notify ignores JAYPOST_APPROVERS', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('JAYPOST_MODE', 'direct')
  vi.stubEnv('JAYPOST_APPROVERS', '')
  vi.stubEnv('JAYPOST_BOT_TOKEN', '')
  expect(await main(['send', 'notify', 'done'])).toBe(1)
})
```

- [ ] **Step 2: Run** `vp test test/cli.test.ts`. Expected: the new tests FAIL (empty env exits 1 or 0, vote check not triggered).

- [ ] **Step 3: Implement** in the `send request` action:
  - `const approvers = resolveApprovers(options.user, process.env)` at the top.
  - Service-mode guard condition becomes `isVote || options.retry !== undefined || process.env[APPROVERS_ENV_VAR] !== undefined`, message `error: -u, --require, --retry and ${APPROVERS_ENV_VAR} need JAYPOST_MODE=direct`.
  - In direct mode, `approvers.kind === 'empty'` exits 2 with `error: ${APPROVERS_ENV_VAR} is set but has no ids; a missing GitHub secret is empty too`.
  - `isVote = approvers.kind === 'listed' || options.require !== undefined`.
  - `voters` in `args` comes from `approvers.voters` when listed, instead of `options.user`.
  - Update the `-u` help text to mention it overrides `JAYPOST_APPROVERS`.

- [ ] **Step 4: Run** `vp test test/cli.test.ts`. Expected: PASS. Then `vp check`.

- [ ] **Step 5: Commit** `feat: send request reads voters from JAYPOST_APPROVERS`

### Task 3: Mask voter ids in direct votes

**Files:**
- Modify: `src/commands/send-direct.ts` (`runDirectVote`)
- Test: `test/commands/send-direct.test.ts`

**Interfaces:**
- Consumes: `formatMaskCommands` (Task 1)

- [ ] **Step 1: Write the failing tests**, reusing the file's `createProvider` / `createDeps` / `answerVoter` helpers and the provider overrides from the existing "can't parse" and "normalized" tests:

```ts
test('under github actions voter ids are masked on stderr before they are checked', async () => {
  // bad-id provider, env { ...ENV, GITHUB_ACTIONS: 'true' }, voters ['a', 'bad']
  expect(errors).toEqual(['::add-mask::a', '::add-mask::bad', 'jaypost: invalid user id "bad"'])
})
test('normalized voter ids are masked too, and stdout stays the answer', async () => {
  // numeric provider, env { ...ENV, FAKE_OWNER: '9', GITHUB_ACTIONS: 'true' }, voters ['0111', ' 111'], json: true, '111' answers 0
  expect(errors).toEqual(['::add-mask::0111', '::add-mask::111'])
  expect(printed).toEqual([
    '{"answer":"Yes","timedOut":false,"approved":true,"require":"all","votes":{"111":"Yes"},"rounds":1}',
  ])
})
test('the default owner voter gets no mask line', async () => {
  // env { ...ENV, GITHUB_ACTIONS: 'true' }, rule 'majority', no voters, 'o' answers 0
  expect(errors).toEqual([])
})
```

- [ ] **Step 2: Run** `vp test test/commands/send-direct.test.ts`. Expected: the three new tests FAIL.

- [ ] **Step 3: Implement** in `runDirectVote`: before the parse loop, print `formatMaskCommands(args.voters ?? [], deps.env)` through `deps.printError`; after normalizing, print `formatMaskCommands` of the normalized ids that differ from every trimmed raw id. Only `args.voters` are masked (the owner id is already a whole secret). Stderr is the channel because the Action's `run.sh` and `$(...)` capture stdout only. Before committing, confirm from the actions/runner docs or source that workflow commands on stderr are processed; I believe they are (both streams go through the same output handler) but haven't checked. If they aren't, stop and report back rather than switching to stdout.

- [ ] **Step 4: Run** `vp test test/commands/send-direct.test.ts`. Expected: PASS, existing tests unchanged (no `GITHUB_ACTIONS` in their env). Then `vp check`.

- [ ] **Step 5: Commit** `feat: mask voter ids in github actions logs`

### Task 4: Shared CI pairing and `jaypost pair approver`

**Files:**
- Create: `src/commands/ci-pairing.ts` (moved out of `setup-ci.ts`)
- Create: `src/commands/pair-approver.ts`
- Modify: `src/commands/setup-ci.ts` (use the moved helpers; behavior unchanged in this task)
- Modify: `src/commands/types.ts`, `src/commands/constants.ts`, `src/commands/index.ts`, `src/cli.ts`
- Test: `test/commands/pair-approver.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces in `src/commands/types.ts`:
  - `type PairingWaiter = (instructions: (code: string) => string) => Promise<OwnerPairing>` (moved)
  - `type OpenedRuntime = { readonly kind: 'opened'; readonly provider: Provider; readonly settings: SettingValues; readonly runtime: ProviderRuntime } | { readonly kind: 'failed' }`
  - `type PairApproverArgs = { readonly provider?: string }`
  - `type PairApproverDeps = SetupCiDeps` (same needs; JSDoc says so)
- Produces in `src/commands/ci-pairing.ts`:
  - `runCiPairing(deps: SetupCiDeps, run: (seen: string[]) => Promise<number>): Promise<number>`: the try/catch now in `runSetupCi` (PromptAborted or aborted signal prints `''` and returns 130; other errors print `Setup failed: <redacted>` and return 1).
  - `openPairingRuntime(providerName: string | undefined, deps: SetupCiDeps, seen: string[]): Promise<OpenedRuntime>`: choose provider (prints `Unknown provider "<name>".`), resolve settings, create runtime, check credentials (prints `Setup failed: <reason>` and stops the runtime). Returns `failed` after printing.
  - `createPairingWaiter(runtime: ProviderRuntime, deps: SetupCiDeps): PairingWaiter` and `stopRuntime(runtime: ProviderRuntime): Promise<void>`, moved unchanged.
- Produces in `src/commands/pair-approver.ts`: `runPairApprover(args: PairApproverArgs, deps: PairApproverDeps): Promise<number>`, exported from `src/commands/index.ts`.
- Produces in `src/commands/constants.ts`: `PAIRED_APPROVERS_HEADING = 'Add these to your approvers list and the JAYPOST_APPROVERS secret (each also works as -u ID):'`

- [ ] **Step 1: Move the helpers** into `ci-pairing.ts` and make `runSetupCi` use `runCiPairing` and `openPairingRuntime`. Run `vp test test/commands/setup-ci.test.ts`. Expected: PASS unchanged (pure refactor).

- [ ] **Step 2: Commit** `refactor: move ci pairing helpers out of setup-ci`

- [ ] **Step 3: Write the failing tests** in `test/commands/pair-approver.test.ts`. Copy the helpers `createPrompts`, `createProvider`, `createDeps`, `createCodes`, `createConfirms`, `pairWhenShown` and the constants `CODE`, `APPROVER_CODES`, `ACCEPTED` from `test/commands/setup-ci.test.ts`. `HEADING` is the exact heading string above. Tests, with these assertions:
  - `'pairs one approver without asking, then asks to pair another'`: confirms `(true, false)`; pair `a` then `b`; exit 0; `prompt.confirm` called twice with `('Pair another?', false)`; printed contains `'Approver paired: a'` and `'Approver paired: b'`; `printed.slice(-2)` is `[HEADING, 'a,b']`; `stop` called once.
  - `'pairs no owner and prints no env vars'`: confirms `(false)`; pair `a`; no printed line starts with `JAYPOST_` or equals `FAKE_KEY=k`.
  - `'uses approverPairingInstructions when the provider has it'` and `'falls back to pairingInstructions'`.
  - `'a blocked code says so and asks to pair another'`: printed contains `'Too many wrong pairing codes for that approver.'`; next code pairs `b`; tail is `[HEADING, 'b']`.
  - `'prints no list when nobody paired'`: blocked, then confirm false; exit 0; printed has no `HEADING`.
  - `'an interrupt while waiting prints those paired so far and returns 130'`: tail `[HEADING, 'a']`.
  - `'an interrupted prompt prints those paired so far and returns 130'`: confirm rejects with `PromptAborted` after `a` paired; tail `['', HEADING, 'a']`.
  - `'a provider failure while waiting prints those paired so far and the reason, secrets masked'`: tail `[HEADING, 'a', 'Setup failed: Fake went away, key ***']`, exit 1.
  - `'rejected credentials exit 1 with the reason'`, `'an unknown provider exits 1'`.
  - `'a provider without pairing exits 1'`: `createFakeProvider()` (no owner setting); printed contains `'Setup failed: <label> has no pairing, so it has no approvers to pair'`.
  - `'the runtime starts once and stops once'` across two approvers.

  In `test/cli.test.ts`: `'pair --help lists approver'` (`main(['pair', '--help'])` is 0, stdout contains `approver`) and `'pair approver --provider nope exits 2'`.

- [ ] **Step 4: Run** `vp test test/commands/pair-approver.test.ts test/cli.test.ts`. Expected: FAIL, `runPairApprover` not exported / unknown command `pair`.

- [ ] **Step 5: Implement** `runPairApprover`: `runCiPairing` → `openPairingRuntime` → owner setting check → approver instructions (`approverPairingInstructions ?? pairingInstructions`) → loop. The loop is the current `pairApprovers` from `setup-ci.ts` with two changes: the first wait happens without a prompt, and the prompt is `'Pair another?'`. The final block is `PAIRED_APPROVERS_HEADING` then `ids.join(',')`, printed only when non-empty. Stop the runtime in `finally`. In `src/cli.ts` add `const pair = program.command('pair').description('pair someone with the bot for CI')` and `pair.command('approver').description('pair approvers for direct mode votes and print their ids')` with the same `--provider` option as `setup-ci`, wired through a `runPairApproverCommand` like `runSetupCiCommand`. Bare `jaypost pair` keeps commander's default (help listing `approver`).

- [ ] **Step 6: Run** `vp test` and `vp check`. Expected: PASS.

- [ ] **Step 7: Commit** `feat: jaypost pair approver`

### Task 5: `setup-ci` pairs only the owner

**Files:**
- Modify: `src/commands/setup-ci.ts`, `src/commands/types.ts` (`SetupCiArgs` loses `approversOnly`), `src/commands/constants.ts`, `src/cli.ts`
- Test: `test/commands/setup-ci.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `SETUP_CI_APPROVERS_HINT = 'To add approvers, run: jaypost pair approver'` in `src/commands/constants.ts`

- [ ] **Step 1: Update the tests** in `test/commands/setup-ci.test.ts`:
  - Delete every approver test from `const APPROVER_CODES` down, except `'the runtime starts once and stops once'`, which now pairs only the owner.
  - `'pairs and prints the env vars last'` becomes `'pairs and prints the env vars, then the approvers hint'`: `printed.slice(-6)` is `['JAYPOST_MODE=direct', 'JAYPOST_PROVIDER=fakepair', 'FAKE_KEY=k', 'FAKE_OWNER=owner-1', '', SETUP_CI_APPROVERS_HINT]`.
  - Add `'does not ask about approvers'`: after pairing, `prompt.confirm` was never called with `'Pair an approver?'`.
  - In `test/cli.test.ts`, add `'setup-ci --approvers-only exits 2'`.

- [ ] **Step 2: Run** `vp test test/commands/setup-ci.test.ts test/cli.test.ts`. Expected: FAIL (hint missing, flag still accepted).

- [ ] **Step 3: Implement**: remove `pairApprovers`, `interruptApprovers`, `printApprovers` and the `approversOnly` branch from `setup-ci.ts`; after `printEnvBlock` in the owner path, print `''` and `SETUP_CI_APPROVERS_HINT`, then return 0. Providers without an owner setting still print the env block and return 0 with no hint. Remove `--approvers-only` from `src/cli.ts` and set the description to `'pair an owner for CI and print the env vars for direct mode'`. Update the `runSetupCi` JSDoc.

- [ ] **Step 4: Run** `vp test` and `vp check`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: setup-ci pairs only the owner, approvers move to pair approver`

### Task 6: GitHub Action inputs

**Files:**
- Modify: `action.yml`, `action/run.sh`
- Test: `test/action-script.test.ts`, `test/action-metadata.test.ts`

- [ ] **Step 1: Update the tests:**
  - `test/action-metadata.test.ts`: the inputs list becomes `[... 'allow-text', 'approvers', 'require', 'retry', 'project', ...]`; the step env adds `JAYPOST_APPROVERS: '${{ inputs.approvers }}'`, `INPUT_REQUIRE: '${{ inputs.require }}'`, `INPUT_RETRY: '${{ inputs.retry }}'`.
  - `test/action-script.test.ts`: add a second line to `FAKE_BINARY`: `echo "\${JAYPOST_APPROVERS-unset}" >"$FAKE_ENV_FILE.approvers"`, and add `INPUT_REQUIRE: ''`, `INPUT_RETRY: ''` to `createRunner` defaults. New tests:
    - `'passes approvers through env and require and retry as flags'`: inputs text/`Yes`/`No`, `INPUT_REQUIRE: 'majority'`, `INPUT_RETRY: '2'`, extra env `JAYPOST_APPROVERS: '1,2'`. Args contain `'--require=majority'` and `'--retry=2'` and nothing containing `1,2`; the approvers file reads `1,2`.
    - `'unsets empty approvers'`: extra env `JAYPOST_APPROVERS: ''`; the approvers file reads `unset`.
    - `'retry alone re-asks without a vote'`: `INPUT_RETRY: '1'`, no approvers or require; exit 0, args contain `'--retry=1'`, no `--require`.
    - `'requires require with approvers'`: `expectInputError` with approvers set, message `input require is required with approvers (all or majority)`. `expectInputError` doesn't take extra env today; give it an optional `extraEnv` parameter passed to `setUp`.
    - `'rejects require with empty approvers'`: message `input approvers is empty; pass it from a secret (a missing secret is empty too)`.
    - `'rejects vote inputs on notify'`: each of `approvers`, `require`, `retry` → `input <name> only applies to command request`.

- [ ] **Step 2: Run** `vp test test/action-script.test.ts test/action-metadata.test.ts`. Expected: new tests FAIL.

- [ ] **Step 3: Implement**:
  - `action.yml`: add the three inputs after `allow-text`. Descriptions: `approvers`: "Approver ids, comma or space separated, for a vote. Pass them from a secret; needs require." `require`: "How the vote decides, all or majority; needs approvers (command request)." `retry`: "Ask again up to N times after a timeout, 0 to 100 (command request)." Add the three env entries.
  - `run.sh`: read `INPUT_REQUIRE`, `INPUT_RETRY`, `JAYPOST_APPROVERS`. In the notify branch add the three "only applies" checks (`approvers` counts when non-empty). In the request branch add the two pairing checks, approvers-without-require first. After validation, `unset JAYPOST_APPROVERS` when empty, and append `--require=...` / `--retry=...` when set. Leave value validation of `require`/`retry` to the binary. Update the header comment listing the env vars read.

- [ ] **Step 4: Run** `vp test` and `vp check`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: approvers, require and retry inputs on the github action`

### Task 7: Docs and changesets

**Files:**
- Modify: `docs/ci.md`, `docs/commands.md`, `docs/scripts.md`
- Create: `.changeset/approvers-secret.md`, `.changeset/pair-approver.md`

- [ ] **Step 1: Update docs:**
  - `docs/ci.md`: the setup-ci paragraph (line 14) says `setup-ci` pairs the owner, and approvers are paired with `jaypost pair approver` (one code per person, `Pair another?`, prints the new ids as a comma list to add to your own list and the secret; GitHub can't show a secret's value back). Discord note stays. Action section: three new rows in the inputs table and a vote example like the spec's. "Several approvers" section: `JAYPOST_APPROVERS` from a per-step secret with the spec's YAML example; `-u` wins; set-but-empty exits 2; ids masked in Actions logs; `-u`, `--require`, `--retry` and `JAYPOST_APPROVERS` exit 2 in service mode; in the Action, `approvers` and `require` go together.
  - `docs/commands.md`: `setup-ci` usage loses `[--approvers-only]` and the description points to `pair approver`; add a `### jaypost pair approver` entry with usage `jaypost pair approver [--provider NAME]`.
  - `docs/scripts.md` line 16: mention `JAYPOST_APPROVERS` as the env alternative to `-u`.

- [ ] **Step 2: Write changesets** (frontmatter `"jaypost": minor`, matching `.changeset/` history):
  - `approvers-secret.md`: `JAYPOST_APPROVERS` holds the voters for direct `send request` (overridden by `-u`; set but empty exits 2; exits 2 in service mode). Voter ids are masked in GitHub Actions logs. The Action takes `approvers`, `require` and `retry`.
  - `pair-approver.md`: new `jaypost pair approver`. Breaking: `setup-ci` no longer pairs approvers and `--approvers-only` is gone; use `jaypost pair approver`.

- [ ] **Step 3: Run** `vp check` and `vp test`. Expected: PASS. `grep -rn "approvers-only\|Pair an approver" docs src README.md` finds nothing outside `docs/superpowers/`.

- [ ] **Step 4: Commit** `docs: approvers secret, masking and pair approver`
