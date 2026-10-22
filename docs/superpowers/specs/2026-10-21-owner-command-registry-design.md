# Owner command registry

## Intent

One owner command (`/pending`, `/cancel`, `/history`, `/mute`, `/unmute`, `/quiet`) is defined in up to five places today:

- Name: the `OwnerCommand['name']` union in the approval module, quiet's names included (`src/approval/types.ts:173`).
- Description: `OWNER_COMMANDS` (`src/approval/constants.ts:52`) or `QUIET_COMMANDS` (`src/quiet/constants.ts:23`).
- Handler: a `switch` in `runOwnerCommand` (`src/approval/commands.ts:30`) or `QuietService.handleCommand` (`src/quiet/service.ts:57`), each returning `undefined` for names it doesn't own.
- Dispatch: `runOwnerCommand(...) ?? quiet.handleCommand(...)` in the daemon (`src/daemon/service.ts:133-138`).
- Argument name and help: `COMMAND_OPTIONS` in the Discord adapter only (`src/discord/constants.ts:52`), keyed by the approval union.

Adding a command with an argument to an existing owner touches 3-4 files in 2-3 modules (approval type, owner's list, owner's switch, Discord constants). A command owned by a new module also touches the daemon. The locality is poor, and the split has failure modes nothing checks:

- A name in a menu list but missing from the switch shows in both menus, then Telegram stays silent (`src/telegram/adapter.ts:518`) and Discord answers "Unknown command." (`src/discord/events.ts:116-120`).
- A name owned by both modules is silently shadowed: the `??` chain runs approval first.
- Help text drifts: Discord's `/history` option says `(1-20)` as a literal while the real limit is `HISTORY_LIMIT` in the approval module (`src/approval/constants.ts:44`).

The idea: each owning module contributes whole commands (name, description, argument, run), the daemon composes the lists, and both adapters render from the composed list.

## Goals

- One place per command: the module that owns its behavior also owns its name, description and argument help.
- Approval stops knowing quiet's names; `OwnerCommand['name']` becomes `string`.
- Composition rejects duplicate or unrenderable names at startup instead of shadowing them.
- Adapters render both menus from the command list: Telegram's `setMyCommands` (`src/telegram/adapter.ts:541`) and Discord's slash command options (`src/discord/commands.ts:6`). No adapter keeps per-command tables.

## Non-goals

- No new commands, no renamed commands, no changed reply text.
- No change to the owner check or to where command dispatch lives in each adapter; `2026-10-21-owner-conversation-design.md` may move that.
- No reshaping of `RuntimeHandlers` beyond the two command fields; the rest is `2026-10-21-provider-runtime-contract-design.md`.
- No typed or required arguments, subcommands or choices.

## Anti-goals

- A plugin-style registry with registration side effects or a global mutable list. Composition is a pure function over plain arrays.
- Moving parsing of arguments (`parseHistoryCount`, `parseMuteDuration`) out of the owning modules.
- Telegram-specific or Discord-specific fields in the command definition.

## Decided by me (owner can override)

- The type stays in the approval module (`src/approval/types.ts`), widened. Quiet already imports it from there (`src/quiet/constants.ts:1`), and both adapters do. Moving it to the provider module would make approval and quiet import from a module whose `registry.ts` imports both adapters (`src/provider/registry.ts:1-2`). A new standalone module is the clean option but costs a sixth import path for three types; I don't think it pays yet.
- `composeOwnerCommands` lives next to the approval commands (`src/approval/commands.ts`), is called by the daemon, and throws a plain `Error` on a duplicate name or a name outside `^[a-z0-9_]{1,32}$`. That pattern is what I believe both Telegram and Discord accept for command names; worth rechecking against their docs. These are broken invariants in constant data, so throwing is right; `runService` already logs and exits 1 when `startService` throws.
- Argument spec is at most one optional free-text argument: `{ name, description }`. Telegram has no argument metadata, so the text after the command (grammY's `context.match`) is the argument. Discord maps it to one optional string option, exactly what `toCommandBodies` builds today (`src/discord/client.ts:307`) and what interaction parsing reads back (`src/discord/client.ts:264-273`).
- The composed `run` trims the argument once and returns `undefined` for unknown names. Today both owners trim themselves (`src/approval/commands.ts:10`, `src/quiet/service.ts:59`).
- Telegram's menu text doesn't change. The argument spec only feeds Discord for now (see Open questions).
- Usage strings in replies (`HISTORY_USAGE`, `MUTE_USAGE`, `QUIET_USAGE`) stay where they are. They're reply text, not menu metadata.

## Constraints

- Adapters see only the spec half (`OwnerCommandSpec`), never `run`; dispatch still goes through `RuntimeHandlers.command`, so the seam between daemon and providers keeps one way to run a command.
- Nothing here is in the published library's exports (`src/index.ts` exports none of these), so no breaking change.
- Repo formatting (no semicolons, single quotes, width 100), `vp check` and `vp test` stay green after each step.

## Proposed interface

```ts
// src/approval/types.ts
/** What a provider shows for one owner command; the argument is always optional free text. */
export type OwnerCommandSpec = {
  readonly name: string
  readonly description: string
  readonly argument?: { readonly name: string; readonly description: string }
}

/** A command and its handler; `run` gets the trimmed argument ('' when none). Never throws. */
export type OwnerCommand = OwnerCommandSpec & { readonly run: (argument: string) => string }

export type OwnerCommandSet = {
  readonly commands: readonly OwnerCommandSpec[]
  /** Reply text, or undefined for a name not in `commands`. Never throws. */
  readonly run: (name: string, argument: string) => string | undefined
}

// src/approval/commands.ts
export function createApprovalCommands(
  service: ApprovalService,
  options: OwnerCommandOptions,
): readonly OwnerCommand[]
/** Keeps list order; throws on a duplicate or invalid name. */
export function composeOwnerCommands(
  ...lists: readonly (readonly OwnerCommand[])[]
): OwnerCommandSet

// src/quiet/service.ts
class QuietService {
  commands(): readonly OwnerCommand[]
}

// src/daemon/service.ts
const owner = composeOwnerCommands(
  createApprovalCommands(service, { now: () => new Date(), maxTextLength: provider.maxTextLength }),
  quiet.commands(),
)
// handlers: { commands: owner.commands, command: owner.run, ... }
```

`RuntimeHandlers.commands` becomes `readonly OwnerCommandSpec[]` (`src/provider/types.ts:59`). The depth gain is small and honest: the interface providers see barely changes, but the implementation behind it stops being spread over four modules. Leverage shows up only when a command is added or changed.

## Tests

Replace, don't keep old and new side by side.

- `test/approval/commands.test.ts`: the `runOwnerCommand(service, name, ...)` cases go through a top-of-file helper that runs `composeOwnerCommands(createApprovalCommands(service, OPTIONS)).run`. Delete "unknown name returns undefined" (line 105) and "OWNER_COMMANDS names and order" (line 111). New: composed order is list order, duplicate name throws, invalid name throws, argument is trimmed, unknown name gives `undefined`.
- `test/quiet/service.test.ts`: `service.handleCommand(...)` calls go through the same kind of helper over `service.commands()`. Delete "unknown commands are left to someone else" (line 135) and the `QUIET_COMMANDS` names test (line 158); one test asserts `commands()` names and argument specs.
- `test/discord/commands.test.ts`: same expectations, but the input is a local fixture of specs with `argument`, not `OWNER_COMMANDS`/`QUIET_COMMANDS`. That's the test proving argument maps to a Discord option.
- `test/telegram/adapter.test.ts`, `test/telegram/runtime.test.ts`, `test/discord/runtime.test.ts`, `test/discord/events.test.ts`: swap `OWNER_COMMANDS` and `QUIET_COMMANDS` for a local spec fixture. Adapter tests shouldn't depend on which commands approval ships.
- `test/daemon/service.test.ts:258`: assert the composed names `['pending', 'cancel', 'history', 'mute', 'unmute', 'quiet']` instead of the spread of two constants.

## Migration steps

1. Add optional `argument` to `OwnerCommand`, fill it in `OWNER_COMMANDS` (with `HISTORY_LIMIT` in the text) and `QUIET_COMMANDS`; `toCommandDefinitions` reads `command.argument`. Delete `COMMAND_OPTIONS` and its export (`src/discord/index.ts:8`). Discord test expectations don't change.
2. Widen `OwnerCommand['name']` to `string`. Nothing else should need the union once `COMMAND_OPTIONS` is gone.
3. Add `OwnerCommandSpec`, `OwnerCommandSet`, `composeOwnerCommands`, `createApprovalCommands` and `QuietService.commands()`, built on the existing switch bodies. Point the daemon at them. Old exports stay; add the compose tests.
4. Move approval and quiet tests to the new helpers, adapter tests to local fixtures, then delete `runOwnerCommand`, `handleCommand`, `OWNER_COMMANDS`, `QUIET_COMMANDS` and their exports. Narrow `RuntimeHandlers.commands` to `OwnerCommandSpec`.
5. Drop the per-owner `trim()` calls now that the composed `run` trims.

## Left to the builder

- Whether descriptions stay in `constants.ts` and get joined to handlers in `createApprovalCommands`, or live inline in the command objects.
- The exact `Error` messages, following the repo's `<what> <quoted value> <problem>` shape.
- Whether to also check description lengths at compose time (Discord's limit is lower than Telegram's, 100 vs 256 as far as I know).
- Whether to compose before `checkCredentials` in `startService` so a bad list fails before any network call. The approval commands need the `ApprovalService`, which is created after it today.

## Open questions

- Worth doing now? Six commands, two owners, and the composition already works. The real wins are the shadowing check and the `(1-20)` drift, both small. My take: do it with the next command that gets added, or alongside the owner-conversation work if that touches command dispatch anyway. Not on its own.
- Should Telegram's menu show the argument, e.g. `Show recent answers [count]`? It'd use the spec on both providers but changes text the owner already sees.
- Should the type move to its own module if `2026-10-21-owner-conversation-design.md` creates a provider-agnostic owner module? That module might be the natural home for `OwnerCommandSpec` and `composeOwnerCommands`.
