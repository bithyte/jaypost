import type { CreatedKey, KeysBody } from '@jaypost/protocol'
import { formatTable, openAdminCaller, printResult, runAdminCommand } from './admin.ts'
import { formatInvite } from './pairing.ts'
import type { AdminDeps, AdminIdArgs, KeyCreateArgs, KeyLabelArgs, KeyListArgs } from './types.ts'

function formatKeys(body: KeysBody): string {
  if (body.keys.length === 0) {
    return 'No keys.'
  }
  return formatTable(
    ['ID', 'BOT', 'PAIRING', 'LABEL', 'EXTERNAL ID', 'CREATED'],
    body.keys.map((key) => [
      key.id,
      key.bot,
      key.pairing,
      key.label,
      key.externalId,
      key.createdAt.slice(0, 10),
    ]),
  )
}

/** The key, once, then the pairing code and how to use it while the pairing waits. */
function formatCreatedKey(created: CreatedKey): string {
  return [
    `Key ${created.id} (pairing ${created.pairing}): ${created.key}`,
    "This key isn't shown again; store it now.",
    ...(created.code === undefined
      ? []
      : [
          formatInvite(created.code, created.instructions),
          'The key works once someone sends that code to the bot.',
        ]),
  ].join('\n')
}

/** An empty string clears the field (null on the wire); absent keeps it. */
function toUpdatedField(
  name: 'label' | 'externalId',
  value: string | undefined,
): { readonly label?: string | null } | { readonly externalId?: string | null } {
  if (value === undefined) {
    return {}
  }
  return { [name]: value === '' ? null : value }
}

/**
 * Creates an API key for a new pairing on `bot`, an existing `pairing`, or the pairing of the key
 * `sameAs`, and prints it once. Returns 0, 1 on failure, 2 unless exactly one target is given.
 */
export function runKeyCreate(args: KeyCreateArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const targets = [args.bot, args.pairing, args.sameAs].filter((target) => target !== undefined)
    if (targets.length !== 1) {
      deps.printError('give exactly one of --bot, --pairing and --same-as')
      return 2
    }
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    const result = await caller.createKey({
      ...(args.bot === undefined ? {} : { bot: args.bot }),
      ...(args.pairing === undefined ? {} : { pairing: args.pairing }),
      ...(args.sameAs === undefined ? {} : { sameAsKey: args.sameAs }),
      ...(args.label === undefined ? {} : { label: args.label }),
      ...(args.externalId === undefined ? {} : { externalId: args.externalId }),
    })
    return printResult(result, args, deps, formatCreatedKey)
  })
}

/** Prints the keys, all or those of one bot or pairing; never a key itself. */
export function runKeyList(args: KeyListArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    const result = await caller.listKeys({
      ...(args.bot === undefined ? {} : { bot: args.bot }),
      ...(args.pairing === undefined ? {} : { pairing: args.pairing }),
    })
    return printResult(result, args, deps, formatKeys)
  })
}

/** Sets or clears a key's label and external id. Returns 2 when neither is given. */
export function runKeyLabel(args: KeyLabelArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    if (args.label === undefined && args.externalId === undefined) {
      deps.printError('give --label, --external-id or both (an empty value clears it)')
      return 2
    }
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    const result = await caller.updateKey(args.id, {
      ...toUpdatedField('label', args.label),
      ...toUpdatedField('externalId', args.externalId),
    })
    return printResult(result, args, deps, ({ key }) => formatKeys({ keys: [key] }))
  })
}

/** Revokes a key; its open questions end with their timeout answer. Its pairing stays. */
export function runKeyRevoke(args: AdminIdArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    return printResult(await caller.revokeKey(args.id), args, deps, () => `Revoked key ${args.id}.`)
  })
}
