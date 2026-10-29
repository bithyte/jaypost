import { existsSync } from 'node:fs'
import { findOwnerSetting, findProvider } from '@jaypost/core'
import type { Provider, SettingValues } from '@jaypost/core'
import { addBot, openDatabase, RegistryStore, resolveDatabasePath } from '@jaypost/store'
import type { AdminCaller } from '@jaypost/client'
import type { AdminBot, BotsBody } from '@jaypost/protocol'
import { openAdmin, openAdminCaller } from './admin-access.ts'
import { formatCount, formatTable, printResult, runAdminCommand } from './admin.ts'
import { STARTED_MEANWHILE_MESSAGE, toLocalUrl } from './constants.ts'
import { resolveProviderSettings, selectProvider } from './provider-setup.ts'
import type {
  AdminDeps,
  AdminOutputArgs,
  AdminRemoveArgs,
  BotAddArgs,
  LocalAdminEndpoint,
  OpenedAdmin,
} from './types.ts'

/**
 * How `bot add` adds the bot: through the admin API, or straight into a stopped service's
 * registry. `registry` keeps what it takes to probe the service again before writing.
 */
type AddRoute =
  | { readonly kind: 'api'; readonly caller: AdminCaller }
  | RegistryRoute
  | { readonly kind: 'refused' }

type RegistryRoute = {
  readonly kind: 'registry'
  readonly configPath: string
  readonly port: number
  /** Undefined when the admin key can't be read. */
  readonly caller: AdminCaller | undefined
}

/** A bot's state, with the reason when it failed. */
function describeState(bot: AdminBot): string {
  return bot.state === 'failed' && bot.error !== undefined ? `failed: ${bot.error}` : bot.state
}

function formatBots(body: BotsBody): string {
  if (body.bots.length === 0) {
    return 'No bots.'
  }
  return formatTable(
    ['ID', 'PROVIDER', 'LABEL', 'ACCOUNT', 'STATE', 'PAIRINGS', 'KEYS'],
    body.bots.map((bot) => [
      bot.id,
      bot.provider,
      bot.label,
      bot.displayName,
      describeState(bot),
      String(bot.pairingCount),
      String(bot.keyCount),
    ]),
  )
}

/** The settings without the owner, which a bot never takes: pairings hold the people. */
function withoutOwner(provider: Provider, settings: SettingValues): SettingValues {
  const owner = findOwnerSetting(provider)
  return Object.fromEntries(
    Object.entries(settings).filter(([name]) => owner === undefined || name !== owner.configKey),
  )
}

/** Prints why the stopped local service can't take the bot and returns `refused`. */
function refuseStopped(endpoint: LocalAdminEndpoint, deps: AdminDeps): AddRoute {
  const name = endpoint.install === undefined ? 'jaypost' : endpoint.install.target
  deps.printError(
    `The ${name} service isn't running. Start it first, then run jaypost admin bot add again.`,
  )
  return { kind: 'refused' }
}

/**
 * Decides before asking for any setting: the API when the service answers, the registry in the db
 * when a local service that runs from this machine's files is down, else refused (reason
 * printed).
 */
async function chooseAddRoute(opened: OpenedAdmin, deps: AdminDeps): Promise<AddRoute> {
  if (opened.kind === 'failed') {
    deps.printError(opened.message)
    return { kind: 'refused' }
  }
  if (opened.kind === 'noKey') {
    const { endpoint } = opened
    if (endpoint.kind !== 'local' || endpoint.configPath === undefined) {
      deps.printError(opened.message)
      return { kind: 'refused' }
    }
    const status = await deps.fetchStatus(toLocalUrl(endpoint.port), undefined)
    if (status.kind !== 'unreachable') {
      deps.printError(opened.message)
      return { kind: 'refused' }
    }
    return {
      kind: 'registry',
      configPath: endpoint.configPath,
      port: endpoint.port,
      caller: undefined,
    }
  }
  const probe = await opened.caller.listBots()
  if (probe.kind === 'ok') {
    return { kind: 'api', caller: opened.caller }
  }
  const { endpoint } = opened
  if (probe.reason !== 'unreachable' || endpoint.kind !== 'local') {
    deps.printError(probe.message)
    return { kind: 'refused' }
  }
  return endpoint.configPath === undefined
    ? refuseStopped(endpoint, deps)
    : {
        kind: 'registry',
        configPath: endpoint.configPath,
        port: endpoint.port,
        caller: opened.caller,
      }
}

/**
 * Probes the service again right before the registry write: it may have started while the
 * settings were asked, and its next save would drop a bot written behind its back. The API when
 * it now answers to the admin key, the same route while it's still down, else refused.
 */
async function recheckStopped(route: RegistryRoute, deps: AdminDeps): Promise<AddRoute> {
  if (route.caller === undefined) {
    const status = await deps.fetchStatus(toLocalUrl(route.port), undefined)
    if (status.kind === 'unreachable') {
      return route
    }
    deps.printError(STARTED_MEANWHILE_MESSAGE)
    return { kind: 'refused' }
  }
  const probe = await route.caller.listBots()
  if (probe.kind === 'ok') {
    return { kind: 'api', caller: route.caller }
  }
  if (probe.reason === 'unreachable') {
    return route
  }
  deps.printError(probe.message)
  return { kind: 'refused' }
}

/**
 * Adds the bot to the registry in jaypost.db next to `configPath`, for a service that isn't
 * running. Refuses while the registry has no seed but a config file exists: the service would then
 * seed its first bot under a later id, so it has to start once first. Returns the exit code.
 */
function addBotToRegistry(
  configPath: string,
  provider: Provider,
  settings: SettingValues,
  args: BotAddArgs,
  deps: AdminDeps,
): number {
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    return addBotToStore(new RegistryStore(database), configPath, provider, settings, args, deps)
  } finally {
    database.close()
  }
}

function addBotToStore(
  store: RegistryStore,
  configPath: string,
  provider: Provider,
  settings: SettingValues,
  args: BotAddArgs,
  deps: AdminDeps,
): number {
  const registry = store.load()
  if (registry.seed === undefined && existsSync(configPath)) {
    deps.printError(
      "The service isn't running and hasn't set up its registry yet. Start it once, then run jaypost admin bot add again.",
    )
    return 1
  }
  const now = deps.now ?? (() => new Date())
  const label = args.label === undefined ? {} : { label: args.label }
  const result = addBot(registry, { provider, settings, ...label }, now())
  if (result.kind === 'duplicate') {
    deps.printError(`bot ${result.botId} already uses these credentials`)
    return 1
  }
  store.save(result.registry)
  const { id } = result.bot
  deps.print(
    args.json
      ? JSON.stringify({ bot: { id, provider: provider.name, ...label } }, null, 2)
      : `Added bot ${id} (${provider.label}).`,
  )
  deps.printError("The service isn't running; it starts the bot on its next start.")
  return 0
}

/**
 * Asks for a provider and its settings (never the owner), checks them and adds the bot through
 * the admin API. When the local service is down and runs from this machine's files, writes the
 * registry in jaypost.db instead; a stopped container has to be started first. Returns 0, 1 on
 * failure, 130 on Ctrl-C. The bot token is never printed.
 */
export function runBotAdd(args: BotAddArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async (seen) => {
    const route = await chooseAddRoute(await openAdmin(deps), deps)
    if (route.kind === 'refused') {
      return 1
    }
    const provider =
      args.provider === undefined
        ? await selectProvider(deps.providers, deps.prompt.select, undefined)
        : findProvider(deps.providers, args.provider)
    if (provider === undefined) {
      deps.printError(`Unknown provider ${JSON.stringify(args.provider)}.`)
      return 1
    }
    const resolved = await resolveProviderSettings({
      provider,
      saved: {},
      prompt: deps.prompt,
      print: deps.printError,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      seen,
    })
    if (resolved.kind === 'rejected') {
      return 1
    }
    const settings = withoutOwner(provider, resolved.settings)
    const target = route.kind === 'registry' ? await recheckStopped(route, deps) : route
    if (target.kind === 'refused') {
      return 1
    }
    if (target.kind === 'registry') {
      return addBotToRegistry(target.configPath, provider, settings, args, deps)
    }
    const result = await target.caller.addBot({
      provider: provider.name,
      settings,
      ...(args.label === undefined ? {} : { label: args.label }),
    })
    return printResult(result, args, deps, ({ bot }) => {
      const account = bot.displayName === undefined ? '' : `, ${bot.displayName}`
      return `Added bot ${bot.id} (${provider.label}${account}): ${describeState(bot)}.`
    })
  })
}

/** Prints every bot with its state and how many pairings and keys it has. */
export function runBotList(args: AdminOutputArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    return printResult(await caller.listBots(), args, deps, formatBots)
  })
}

/**
 * Removes a bot with its pairings and keys, after saying how many keys go with it and asking
 * (unless `yes`). Returns 0, also when declined.
 */
export function runBotRemove(args: AdminRemoveArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    if (!args.yes) {
      const listed = await caller.listBots()
      if (listed.kind === 'failed') {
        deps.printError(listed.message)
        return 1
      }
      const bot = listed.value.bots.find((candidate) => candidate.id === args.id)
      if (bot === undefined) {
        deps.printError(`unknown bot ${JSON.stringify(args.id)}`)
        return 1
      }
      const name = bot.label ?? bot.displayName ?? bot.provider
      const question =
        `Remove bot ${bot.id} (${name})? This removes ${formatCount(bot.pairingCount, 'pairing')} ` +
        `and revokes ${formatCount(bot.keyCount, 'key')}.`
      if (!(await deps.prompt.confirm(question, false))) {
        deps.printError('Nothing removed.')
        return 0
      }
    }
    return printResult(await caller.removeBot(args.id), args, deps, ({ removedKeys }) => {
      const ids = removedKeys.length === 0 ? '' : ` (${removedKeys.join(', ')})`
      return `Removed bot ${args.id} and ${formatCount(removedKeys.length, 'key')}${ids}.`
    })
  })
}
