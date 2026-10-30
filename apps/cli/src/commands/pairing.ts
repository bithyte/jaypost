import type { ContactInvite, ContactsBody } from '@jaypost/protocol'
import { openAdminCaller } from './admin-access.ts'
import { formatCount, formatTable, printResult, runAdminCommand } from './admin.ts'
import type { AdminDeps, AdminRemoveArgs, PairingCreateArgs, PairingListArgs } from './types.ts'

/** The pairing code and, when the bot gives them, the instructions for sending it. */
export function formatInvite(code: string, instructions: string | undefined): string {
  return [`Pairing code: ${code}`, ...(instructions === undefined ? [] : [instructions])].join('\n')
}

function formatPairings(body: ContactsBody): string {
  if (body.contacts.length === 0) {
    return 'No pairings.'
  }
  return formatTable(
    ['ID', 'BOT', 'STATE', 'PERSON', 'CODE', 'KEYS'],
    body.contacts.map((pairing) => [
      pairing.id,
      pairing.bot,
      pairing.state,
      pairing.person,
      pairing.code,
      pairing.keys.join(','),
    ]),
  )
}

function formatCreatedPairing(invite: ContactInvite): string {
  const { contact: pairing } = invite
  if (invite.code === undefined) {
    return `Pairing ${pairing.id} on bot ${pairing.bot} is ready.`
  }
  return [
    `Pairing ${pairing.id} on bot ${pairing.bot}.`,
    formatInvite(invite.code, invite.instructions),
  ].join('\n')
}

/** Creates a pairing with no key (an approver invite) and prints its code. */
export function runPairingCreate(args: PairingCreateArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    return printResult(
      await caller.createContact({ bot: args.bot }),
      args,
      deps,
      formatCreatedPairing,
    )
  })
}

/** Prints the pairings, all or one bot's, with the code of each pending one. */
export function runPairingList(args: PairingListArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    const result = await caller.listContacts(args.bot === undefined ? {} : { bot: args.bot })
    return printResult(result, args, deps, formatPairings)
  })
}

/**
 * Removes a pairing and revokes its keys, after saying how many and asking (unless `yes`).
 * Returns 0, also when declined.
 */
export function runPairingRemove(args: AdminRemoveArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    if (!args.yes) {
      const listed = await caller.listContacts({})
      if (listed.kind === 'failed') {
        deps.printError(listed.message)
        return 1
      }
      const pairing = listed.value.contacts.find((candidate) => candidate.id === args.id)
      if (pairing === undefined) {
        deps.printError(`unknown pairing ${JSON.stringify(args.id)}`)
        return 1
      }
      const question = `Remove pairing ${pairing.id} on bot ${pairing.bot}? This revokes ${formatCount(pairing.keys.length, 'key')}.`
      if (!(await deps.prompt.confirm(question, false))) {
        deps.printError('Nothing removed.')
        return 0
      }
    }
    return printResult(await caller.removeContact(args.id), args, deps, ({ removedKeys }) => {
      const ids = removedKeys.length === 0 ? '' : ` (${removedKeys.join(', ')})`
      return `Removed pairing ${args.id} and revoked ${formatCount(removedKeys.length, 'key')}${ids}.`
    })
  })
}
