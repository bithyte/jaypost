import { describeEndpoint } from '@jaypost/client'
import { findBot, removeBookBot, renameBot, setDefaultBot, writeBook } from '@jaypost/store'
import type { Book, BookChange } from '@jaypost/store'
import { formatTable } from './admin.ts'
import { loadBook } from './remote.ts'
import type { BookDeps } from './types.ts'

/** Prints each bot's alias and service, marking the default with `*`; never a key. Returns the exit code. */
export function runBotsList(deps: BookDeps): Promise<number> {
  const book = loadBook(deps)
  if (book === undefined) {
    return Promise.resolve(1)
  }
  if (book.bots.length === 0) {
    deps.print('No bots. Run "jaypost service install" or "jaypost join".')
    return Promise.resolve(0)
  }
  deps.print(
    formatTable(
      ['', 'ALIAS', 'SERVICE'],
      book.bots.map((bot) => [
        // A space, not '', because formatTable shows an empty cell as '-'.
        bot.alias === book.default ? '*' : ' ',
        bot.alias,
        describeEndpoint(new URL(bot.url)),
      ]),
    ),
  )
  return Promise.resolve(0)
}

/** Makes `alias` the default bot. Returns the exit code. */
export function runBotsDefault(args: { readonly alias: string }, deps: BookDeps): Promise<number> {
  return Promise.resolve(
    applyChange(
      deps,
      (book) => setDefaultBot(book, args.alias),
      (book) => {
        deps.print(`Default bot is now "${book.default}".`)
      },
    ),
  )
}

/** Renames a bot; the default follows it. Returns the exit code. */
export function runBotsRename(
  args: { readonly alias: string; readonly newAlias: string },
  deps: BookDeps,
): Promise<number> {
  return Promise.resolve(
    applyChange(
      deps,
      (book) => renameBot(book, args.alias, args.newAlias),
      () => {
        deps.print(`Renamed "${args.alias}" to "${args.newAlias}".`)
      },
    ),
  )
}

/**
 * Removes a bot after a confirmation unless `yes`; declining leaves the book as it was. Removing
 * the default with others left asks which becomes the default on a terminal, and otherwise moves
 * it to the first remaining bot and says so. Returns the exit code.
 */
export async function runBotsRemove(
  args: { readonly alias: string; readonly yes?: boolean },
  deps: BookDeps,
): Promise<number> {
  const book = loadBook(deps)
  if (book === undefined) {
    return 1
  }
  const change = removeBookBot(book, args.alias)
  if (change.kind === 'failed') {
    deps.printError(change.message)
    return 1
  }
  if (
    args.yes !== true &&
    !(await deps.prompt.confirm(`Remove "${args.alias}" from your contacts?`, false))
  ) {
    deps.printError('Cancelled.')
    return 1
  }
  const removed = findBot(book, args.alias)
  const wasDefault =
    removed !== undefined &&
    book.default !== undefined &&
    book.default.toLowerCase() === removed.alias.toLowerCase()
  const next =
    wasDefault && change.book.bots.length > 0 ? await chooseDefault(change.book, deps) : change.book
  writeBook(deps.bookPath, next)
  deps.print(`Removed "${removed?.alias ?? args.alias}".`)
  if (wasDefault && next.default !== undefined) {
    deps.print(`Default bot is now "${next.default}".`)
  }
  return 0
}

// On a terminal the user picks the next default; otherwise removeBot's pick stands.
async function chooseDefault(book: Book, deps: BookDeps): Promise<Book> {
  if (!deps.isInteractive || book.default === undefined) {
    return book
  }
  const alias = await deps.prompt.select(
    'Which bot is the new default?',
    book.bots.map((bot) => ({ value: bot.alias, label: bot.alias })),
    book.default,
  )
  const chosen = setDefaultBot(book, alias)
  return chosen.kind === 'changed' ? chosen.book : book
}

// Loads the book, applies one operation, writes it and reports; a failure prints and writes nothing.
function applyChange(
  deps: BookDeps,
  change: (book: Book) => BookChange,
  report: (book: Book) => void,
): number {
  const book = loadBook(deps)
  if (book === undefined) {
    return 1
  }
  const result = change(book)
  if (result.kind === 'failed') {
    deps.printError(result.message)
    return 1
  }
  writeBook(deps.bookPath, result.book)
  report(result.book)
  return 0
}
