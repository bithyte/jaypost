# jaypost service location design

## Intent

Every CLI command that talks to the running service has to answer "which port is it on?". Today there are two caller-side answers, and `jaypost test` disagrees with `jaypost send`, `hook`, `mcp` and `openapi` about it:

- `send`, `hook`, `mcp`, `openapi` call `resolveMcpPort` (src/mcp/port.ts:5-19): `--port`, then `PORT`, then install.json, then 8787. The README documents this rule (README.md:143, 192).
- `test` has no `--port`. It calls `runTest(resolvePort(), installFile, token)` (src/cli.ts:420-429), and `runTest` takes install.json first (src/commands/test.ts:15). Only without install.json does it fall back to `resolvePort` (src/cli.ts:53-60): `loadConfig().port` (`PORT`, then config.json, then 8787, src/config/store.ts:138), or on any `loadConfig` error a loosely parsed `PORT` (`Number(process.env.PORT)`, no upper bound), then 8787.

Two concrete cases where they disagree:

1. `jaypost init --port 9000` on systemd, and the shell exports `PORT=3000` for the user's own app (the case README.md:192 warns about). `jaypost send notify hi` goes to 3000 and fails; `jaypost test` goes to 9000 and works. So `test` reports success for a path the hook and the agent won't take.
2. `jaypost uninstall`, answer "no" to purge. install.json is gone, config.json keeps the bot token and `port: 9000` (written by `writeServiceConfig`, src/install/native.ts:175-189; kept per README.md:649). The user runs `jaypost start` by hand; the daemon listens on 9000 (src/config/store.ts:138). `jaypost test` reaches it through config.json; `send`, `hook` and `mcp` try 8787. README.md:143 tells the user to pass `--port` here, so for `send` it's documented, but `test` still doesn't predict what `send` does.

I don't know whether `test`'s rule was a choice. From git history, `test` read `loadConfig().port` first (fca67bd), got the install.json lookup in d44a0db, and `resolveMcpPort` came later (dcf76d7) with a deliberately different rule for `mcp` (the comment at src/cli.ts:455). `send` and `hook` adopted it; `test` was never moved over. Nothing in the code or README says `test` should differ, so I'm treating it as drift.

The other port readers differ on purpose and stay as they are: the daemon reads its own listen port from env and config.json (`loadConfig`), `status`/`reset-owner`/`log` report the recorded install through `findExistingInstall` (src/install/registry.ts:64-88), and the library `Client` defaults to 8787 (src/client/client.ts:33).

So the candidate is small: one caller-side resolver module, out of mcp/, used by all five commands. The leverage is that "what `test` checks" and "what the agent does" become the same function, not that the module gets deep. It's about 30 lines either way.

## Goals

- One function decides the caller-side port. `send`, `hook`, `mcp`, `openapi` and `test` all call it.
- `jaypost test` gains `--port N`, same help text as the others.
- The resolver lives next to the file it reads (install.json), not in mcp/.
- cli.ts's `resolvePort` and its loose `PORT` parse are deleted.

## Non-goals

- The daemon's own port (`loadConfig`). It's the listener, not a caller; env-then-config.json is right for it.
- `status`, `reset-owner`, `log`, `uninstall`, `update`. They're about the recorded install and its target, and read the port from the record on purpose.
- The library `Client`'s default port. That's for 2026-10-21-client-protocol-design.md (see Open questions).
- Merging the three "provider name + settings" readers. I looked: `readEnvSecrets` (src/install/envfile.ts:68-79) and `readConfigSecrets` (src/install/native.ts:98-109) are lenient install-time readers that already share `collectSettings` (src/provider/settings.ts:22-34) and differ only in where a value comes from. `loadConfig` (src/config/store.ts:118-137) is the daemon's strict reader: env overrides the file, an unknown provider or missing required setting throws. The difference in strictness is the point of each. One reader with a strictness mode flag would be a shallow module whose interface is bigger than the duplication it removes.

## Anti-goals

- A mode or flag on the resolver for "test-style" lookups. One rule.
- Pulling install/ into the published library entry (src/index.ts) just to get a port.
- Changing what `PORT` means for the daemon.

## Decided by me (owner can override)

- Precedence: `--port`, then `PORT` (whole number 1-65535, else ignored), then install.json `port`, then config.json `port`, then 8787. The config.json step is new for `send`/`hook`/`mcp`/`openapi`. Without it, case 2 regresses for `test` (it'd hit 8787 where it hits 9000 today). With it, a hand-run `jaypost start` and its callers agree whenever there's no install, which is exactly the case README.md:143 carves out. It only kicks in when install.json is missing or invalid, so installed setups don't change. The comment at src/cli.ts:455 says `mcp` avoids `loadConfig` because an agent's container may not have config.json; reading just `port` with every error swallowed doesn't have that problem (a missing file yields nothing).
- config.json path comes from `resolveConfigPath(env)`, same as `jaypost start` in that shell.
- Module home: src/install/port.ts, exported from src/install/index.ts. install/ owns install.json's schema and already reads config.json's port for legacy installs (src/install/registry.ts:81-86), so no new dependency edge. `PORT_PATTERN` and `MAX_PORT` move from src/mcp/constants.ts to src/install/constants.ts.
- Name: `resolveServicePort` ("service" as in the running daemon).
- `runTest` takes a resolved port instead of reading install.json; the seam between the CLI shell and the command is a plain `port: number`, same as `SendDeps.port` and `HookDeps.port`.
- `test`'s behavior change (case 1: `PORT` now beats install.json) is intended and goes in the commit message as a `fix:`.

## Constraints

- Repo style as it is today: plain exported functions, no semicolons, single quotes, width 100, tests on `vite-plus/test` with `expect`.
- The resolver never throws: missing, unreadable or invalid install.json/config.json and a bad `PORT` all fall through.
- README stays accurate: update the port sentence at README.md:143, the `--port` note at 192 if it changes, and the command list at 632/647 for `jaypost test [--port N]`.
- No em-dashes anywhere.

## Proposed interface

```ts
// src/install/port.ts
/**
 * Port callers use to reach the local service: `flagPort`, then PORT, then install.json, then
 * config.json's `port`, then 8787. Bad values and unreadable files fall through. Never throws.
 */
export function resolveServicePort(
  flagPort: number | undefined,
  env: NodeJS.ProcessEnv,
  installFile: string,
): number

// src/commands/test.ts
/** Sends the test question to `port`, with the token when one is found. */
export async function runTest(port: number, token: ClientToken): Promise<number>
```

## Tests

Replace old tests rather than adding new ones next to them. All file cases use `mkdtempSync` dirs and pass `JAYPOST_CONFIG` in the `env` argument; no real `~/.config`.

- Move test/mcp/port.test.ts to test/install/port.test.ts, renamed to `resolveServicePort`. Keep its five cases (src lines 20-42). Add: config.json port used when install.json is missing; install.json beats config.json; corrupt install.json falls through to config.json; corrupt config.json falls through to 8787; config.json with an out-of-range `port` falls through.
- test/commands/manage.test.ts: delete "test command takes port from install.json first" (test/commands/manage.test.ts:328-341); precedence now lives in port.test.ts. Change the two other `runTest` tests to the new signature. While there, the builder can swap the `fetch` stub for a `node:http` server on port 0 like test/cli.test.ts does; not required.
- test/cli.test.ts: add `test rejects a bad port with 2`, next to the `mcp` one (test/cli.test.ts:57).
- Optional, if it's cheap with the existing in-process `main()` setup: one regression test for case 1 (install.json says one port, `PORT` points at a `node:http` server on port 0, `main(['test'])` hits the server).

## Migration steps

1. Move `resolveMcpPort` to src/install/port.ts as `resolveServicePort`, with its constants; update the four callers in src/cli.ts (142, 152, 173, 458) and src/mcp/index.ts; move the test file. No behavior change.
2. Add the config.json step to `resolveServicePort` and its tests. Update README.md:143.
3. Change `runTest` to `(port, token)`, add `--port` to the `test` command, call `resolveServicePort` there, delete `resolvePort` and the now-unused `DEFAULT_PORT` import from src/cli.ts. Update manage.test.ts, add the cli.test.ts case, update the README command list.

Step 2 goes before 3 so `test` never loses its config.json fallback in between.

## Left to the builder

- Whether cli.ts's flag parser `parsePort` (src/cli.ts:62-68) and the resolver's env parse share one "valid port text" function, and where `PORT_PATTERN` ends up (cli.ts also uses its own copy for `--limit`, src/cli.ts:51, 97).
- Exact README wording.
- Whether the case-1 regression test is worth its setup.

## Open questions

- Is the config.json step wanted? If the owner prefers the documented rule as is, drop step 2; `test` then hits 8787 in case 2 (a regression for hand-run setups) and README.md:143 stays true for all five commands.
- Should `status` say something when `PORT` is set and differs from the recorded port? It'd explain case 1 from the user's side. Out of scope here; I'm not sure it's worth the noise.
- 2026-10-21-client-protocol-design.md: I'd keep the seam at `port: number` and have client/ accept it, not fold this resolver into client/. Folding it in would make the public `Client` read install.json and config.json and drag install/ into the library entry. If that spec decides `Client` should find the local install by default, the resolver can move into client/ then; it's one file with no callers outside cli.ts.
- I haven't checked whether anything outside this repo (scripts, the site) relies on `jaypost test` ignoring `PORT`.
