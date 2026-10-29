import type { Book, BookBot, BookChange, BookLocal, BookRemote } from './types.ts'

/** The normalized http(s) url, or undefined for credentials, a query, a fragment or another scheme. */
export function toServiceUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined
  }
  return url.href
}

/** The bot with this alias, ignoring case. */
export function findBot(book: Book, alias: string): BookBot | undefined {
  return book.bots.find((bot) => sameName(bot.alias, alias))
}

/** The remote with this name (ignoring case), else the one whose url host equals `name`. */
export function findRemote(book: Book, name: string): BookRemote | undefined {
  return (
    book.remotes.find((remote) => sameName(remote.name, name)) ??
    book.remotes.find((remote) => hostOf(remote.url) === name)
  )
}

/** The first bot on the local install's url, if the book has a local install. */
export function findLocalSeedBot(book: Book): BookBot | undefined {
  const local = book.local
  return local === undefined ? undefined : book.bots.find((bot) => bot.url === local.url)
}

/**
 * Replaces the bot with the same alias (ignoring case) in place, else appends; fills a missing
 * default, and moves the default to the new spelling when the replaced bot was the default.
 */
export function saveBot(book: Book, bot: BookBot): Book {
  const exists = book.bots.some((existing) => sameName(existing.alias, bot.alias))
  const bots = exists
    ? book.bots.map((existing) => (sameName(existing.alias, bot.alias) ? bot : existing))
    : [...book.bots, bot]
  const replacesDefault = book.default !== undefined && sameName(book.default, bot.alias)
  return { ...book, bots, default: replacesDefault ? bot.alias : (book.default ?? bot.alias) }
}

/** Removes a bot; removing the default moves it to the first remaining bot, or clears it. */
export function removeBot(book: Book, alias: string): BookChange {
  const bot = findBot(book, alias)
  if (bot === undefined) {
    return missingBot(alias)
  }
  return { kind: 'changed', book: withoutBots(book, (candidate) => candidate !== bot) }
}

/** Renames a bot; the default follows. Fails when another entry already has `newAlias`. */
export function renameBot(book: Book, alias: string, newAlias: string): BookChange {
  const bot = findBot(book, alias)
  if (bot === undefined) {
    return missingBot(alias)
  }
  const clash = findBot(book, newAlias)
  if (clash !== undefined && clash !== bot) {
    return { kind: 'failed', message: `a bot is already named "${newAlias}"` }
  }
  const bots = book.bots.map((existing) =>
    existing === bot ? { ...existing, alias: newAlias } : existing,
  )
  const isDefault = book.default !== undefined && sameName(book.default, bot.alias)
  return { kind: 'changed', book: { ...book, bots, ...(isDefault ? { default: newAlias } : {}) } }
}

/** Makes `alias` the default bot, stored with its saved spelling. */
export function setDefaultBot(book: Book, alias: string): BookChange {
  const bot = findBot(book, alias)
  if (bot === undefined) {
    return missingBot(alias)
  }
  return { kind: 'changed', book: { ...book, default: bot.alias } }
}

/** Replaces the remote with the same name (ignoring case) in place, else appends. */
export function saveRemote(book: Book, remote: BookRemote): Book {
  const exists = book.remotes.some((existing) => sameName(existing.name, remote.name))
  const remotes = exists
    ? book.remotes.map((existing) => (sameName(existing.name, remote.name) ? remote : existing))
    : [...book.remotes, remote]
  return { ...book, remotes }
}

/** Removes a remote; bots on its url stay. */
export function removeRemote(book: Book, name: string): BookChange {
  const remote = book.remotes.find((existing) => sameName(existing.name, name))
  if (remote === undefined) {
    return { kind: 'failed', message: `no remote "${name}"` }
  }
  return {
    kind: 'changed',
    book: { ...book, remotes: book.remotes.filter((existing) => existing !== remote) },
  }
}

/**
 * Sets the local install. A bot already on `seed.url` with the same key is updated keeping its
 * alias, so a renamed seed survives a reinstall; otherwise `seed` is saved.
 */
export function setLocal(book: Book, local: BookLocal, seed: BookBot): Book {
  const existing = book.bots.find((bot) => bot.url === seed.url && bot.key === seed.key)
  const next = { ...book, local }
  return existing === undefined
    ? saveBot(next, seed)
    : saveBot(next, { ...existing, ...seed, alias: existing.alias })
}

/** Drops the local install and every bot on its url; the default is fixed as in `removeBot`. */
export function removeLocal(book: Book): Book {
  const { local, ...rest } = book
  if (local === undefined) {
    return book
  }
  return withoutBots(rest, (bot) => bot.url !== local.url)
}

function withoutBots(book: Book, keep: (bot: BookBot) => boolean): Book {
  const { default: current, ...rest } = book
  const bots = book.bots.filter(keep)
  const keepsDefault = current !== undefined && bots.some((bot) => sameName(bot.alias, current))
  const next = keepsDefault ? current : bots[0]?.alias
  return { ...rest, bots, ...(next === undefined ? {} : { default: next }) }
}

function missingBot(alias: string): BookChange {
  return { kind: 'failed', message: `no bot "${alias}" in your contacts` }
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
