import type { ContactInvite, ContactsBody, KeysBody } from '@jaypost/protocol'
import { openAdminCaller } from './admin-access.ts'
import { formatCount, formatTable, printResult, runAdminCommand } from './admin.ts'
import type { AdminDeps, AdminRemoveArgs, ContactAddArgs, ContactListArgs } from './types.ts'

/** The pairing code and, when the bot gives them, the instructions for sending it. */
export function formatInvite(code: string, instructions: string | undefined): string {
  return [`Pairing code: ${code}`, ...(instructions === undefined ? [] : [instructions])].join('\n')
}

/** Each key id of `contact`, then a space and its label when it has one, joined with `, `. */
function formatContactKeys(contact: string, keys: KeysBody): string {
  return keys.keys
    .filter((key) => key.contact === contact)
    .map((key) => (key.label === undefined ? key.id : `${key.id} ${key.label}`))
    .join(', ')
}

function formatContacts(body: ContactsBody, keys: KeysBody): string {
  if (body.contacts.length === 0) {
    return 'No contacts.'
  }
  return formatTable(
    ['ID', 'BOT', 'STATE', 'PERSON', 'CODE', 'KEYS'],
    body.contacts.map((contact) => [
      contact.id,
      contact.bot,
      contact.state,
      contact.person,
      contact.code,
      formatContactKeys(contact.id, keys),
    ]),
  )
}

function formatCreatedContact(invite: ContactInvite): string {
  const { contact } = invite
  if (invite.code === undefined) {
    return `Contact ${contact.id} on bot ${contact.bot} is ready.`
  }
  return [
    `Contact ${contact.id} on bot ${contact.bot}.`,
    formatInvite(invite.code, invite.instructions),
  ].join('\n')
}

/** Adds a contact with no key (an approver invite) and prints its pairing code. */
export function runContactAdd(args: ContactAddArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    return printResult(
      await caller.createContact({ bot: args.bot }),
      args,
      deps,
      formatCreatedContact,
    )
  })
}

/**
 * Prints the contacts, all or one bot's, with the code of each pending one and its keys' ids and
 * labels. `--json` prints only what the contacts route returned, with no second call.
 */
export function runContactList(args: ContactListArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    const filter = args.bot === undefined ? {} : { bot: args.bot }
    const contacts = await caller.listContacts(filter)
    if (contacts.kind === 'failed' || args.json === true) {
      return printResult(contacts, args, deps, (body) => JSON.stringify(body))
    }
    const keys = await caller.listKeys(filter)
    if (keys.kind === 'failed') {
      deps.printError(keys.message)
      return 1
    }
    return printResult(contacts, args, deps, (body) => formatContacts(body, keys.value))
  })
}

/**
 * Removes a contact and revokes its keys, after saying how many and asking (unless `yes`).
 * Returns 0, also when declined.
 */
export function runContactRemove(args: AdminRemoveArgs, deps: AdminDeps): Promise<number> {
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
      const contact = listed.value.contacts.find((candidate) => candidate.id === args.id)
      if (contact === undefined) {
        deps.printError(`unknown contact ${JSON.stringify(args.id)}`)
        return 1
      }
      const question = `Remove contact ${contact.id} on bot ${contact.bot}? This revokes ${formatCount(contact.keys.length, 'key')}.`
      if (!(await deps.prompt.confirm(question, false))) {
        deps.printError('Nothing removed.')
        return 0
      }
    }
    return printResult(await caller.removeContact(args.id), args, deps, ({ removedKeys }) => {
      const ids = removedKeys.length === 0 ? '' : ` (${removedKeys.join(', ')})`
      return `Removed contact ${args.id} and revoked ${formatCount(removedKeys.length, 'key')}${ids}.`
    })
  })
}
