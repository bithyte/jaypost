import type { Inbox, InboxBot, InboxChange, InboxLocal, InboxRemote } from './types.ts'

/**
 * `raw` as a service base URL: http or https, no credentials, query or fragment; a path is kept
 * as the prefix of every API path. Undefined when it isn't one. Never throws.
 */
export function parseServiceUrl(raw: string): URL | undefined {
  if (!URL.canParse(raw)) {
    return undefined
  }
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined
  }
  return url
}

/** `parseServiceUrl`'s normalized form, for storing in the inbox. */
export function toServiceUrl(raw: string): string | undefined {
  return parseServiceUrl(raw)?.href
}

/** The bot with this alias, ignoring case. */
export function findBot(inbox: Inbox, alias: string): InboxBot | undefined {
  return inbox.bots.find((bot) => sameName(bot.alias, alias))
}

/** The remote with this name (ignoring case), else the one whose url host equals `name`. */
export function findRemote(inbox: Inbox, name: string): InboxRemote | undefined {
  return (
    inbox.remotes.find((remote) => sameName(remote.name, name)) ??
    inbox.remotes.find((remote) => hostOf(remote.url) === name)
  )
}

/** The first bot on the local install's url, if the inbox has a local install. */
export function findLocalSeedBot(inbox: Inbox): InboxBot | undefined {
  const local = inbox.local
  return local === undefined ? undefined : inbox.bots.find((bot) => bot.url === local.url)
}

/**
 * Replaces the bot with the same alias (ignoring case) in place, else appends; fills a missing
 * default, and moves the default to the new spelling when the replaced bot was the default.
 */
export function saveBot(inbox: Inbox, bot: InboxBot): Inbox {
  const exists = inbox.bots.some((existing) => sameName(existing.alias, bot.alias))
  const bots = exists
    ? inbox.bots.map((existing) => (sameName(existing.alias, bot.alias) ? bot : existing))
    : [...inbox.bots, bot]
  const replacesDefault = inbox.default !== undefined && sameName(inbox.default, bot.alias)
  return { ...inbox, bots, default: replacesDefault ? bot.alias : (inbox.default ?? bot.alias) }
}

/** Removes a bot; removing the default moves it to the first remaining bot, or clears it. */
export function removeBot(inbox: Inbox, alias: string): InboxChange {
  const bot = findBot(inbox, alias)
  if (bot === undefined) {
    return missingBot(alias)
  }
  return { kind: 'changed', inbox: withoutBots(inbox, (candidate) => candidate !== bot) }
}

/** Renames a bot; the default follows. Fails when another entry already has `newAlias`. */
export function renameBot(inbox: Inbox, alias: string, newAlias: string): InboxChange {
  const bot = findBot(inbox, alias)
  if (bot === undefined) {
    return missingBot(alias)
  }
  const clash = findBot(inbox, newAlias)
  if (clash !== undefined && clash !== bot) {
    return { kind: 'failed', message: `a bot is already named "${newAlias}"` }
  }
  const bots = inbox.bots.map((existing) =>
    existing === bot ? { ...existing, alias: newAlias } : existing,
  )
  const isDefault = inbox.default !== undefined && sameName(inbox.default, bot.alias)
  return { kind: 'changed', inbox: { ...inbox, bots, ...(isDefault ? { default: newAlias } : {}) } }
}

/** Makes `alias` the default bot, stored with its saved spelling. */
export function setDefaultBot(inbox: Inbox, alias: string): InboxChange {
  const bot = findBot(inbox, alias)
  if (bot === undefined) {
    return missingBot(alias)
  }
  return { kind: 'changed', inbox: { ...inbox, default: bot.alias } }
}

/** Replaces the remote with the same name (ignoring case) in place, else appends. */
export function saveRemote(inbox: Inbox, remote: InboxRemote): Inbox {
  const exists = inbox.remotes.some((existing) => sameName(existing.name, remote.name))
  const remotes = exists
    ? inbox.remotes.map((existing) => (sameName(existing.name, remote.name) ? remote : existing))
    : [...inbox.remotes, remote]
  return { ...inbox, remotes }
}

/** Removes a remote; bots on its url stay. */
export function removeRemote(inbox: Inbox, name: string): InboxChange {
  const remote = inbox.remotes.find((existing) => sameName(existing.name, name))
  if (remote === undefined) {
    return { kind: 'failed', message: `no remote "${name}"` }
  }
  return {
    kind: 'changed',
    inbox: { ...inbox, remotes: inbox.remotes.filter((existing) => existing !== remote) },
  }
}

/**
 * Sets the local install. A bot already on `seed.url` with the same key is updated keeping its
 * alias, so a renamed seed survives a reinstall; otherwise `seed` is saved.
 */
export function setLocal(inbox: Inbox, local: InboxLocal, seed: InboxBot): Inbox {
  const existing = inbox.bots.find((bot) => bot.url === seed.url && bot.key === seed.key)
  const next = { ...inbox, local }
  return existing === undefined
    ? saveBot(next, seed)
    : saveBot(next, { ...existing, ...seed, alias: existing.alias })
}

/** Drops the local install and every bot on its url; the default is fixed as in `removeBot`. */
export function removeLocal(inbox: Inbox): Inbox {
  const { local, ...rest } = inbox
  if (local === undefined) {
    return inbox
  }
  return withoutBots(rest, (bot) => bot.url !== local.url)
}

function withoutBots(inbox: Inbox, keep: (bot: InboxBot) => boolean): Inbox {
  const { default: current, ...rest } = inbox
  const bots = inbox.bots.filter(keep)
  const keepsDefault = current !== undefined && bots.some((bot) => sameName(bot.alias, current))
  const next = keepsDefault ? current : bots[0]?.alias
  return { ...rest, bots, ...(next === undefined ? {} : { default: next }) }
}

function missingBot(alias: string): InboxChange {
  return { kind: 'failed', message: `no bot "${alias}" in your inbox` }
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
