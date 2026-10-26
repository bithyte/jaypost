import { existsSync } from 'node:fs'
import { findOwnerSetting, findProvider } from '@jaypost/core'
import type { Provider, SettingValues } from '@jaypost/core'
import { addBot, RegistryStore, resolveRegistryPath } from '@jaypost/store'
import type { AdminCaller } from '@jaypost/client'
import type { AdminBot, BotsBody } from '@jaypost/protocol'
import { isNativeInstall } from './admin-endpoint.ts'
import {
  formatCount,
  formatTable,
  openAdmin,
  openAdminCaller,
  printResult,
  runAdminCommand,
} from './admin.ts'
import { resolveProviderSettings, selectProvider } from './provider-setup.ts'
import type {
  AdminDeps,
  AdminOutputArgs,
  AdminRemoveArgs,
  BotAddArgs,
  LocalAdminEndpoint,
  OpenedAdmin,
} from './types.ts'

/** How `bot add` adds the bot: through the admin API, or straight into a stopped service's registry. */
type AddRoute =
  | { readonly kind: 'api'; readonly caller: AdminCaller }
  | { readonly kind: 'registry'; readonly configPath: string }
  | { readonly kind: 'refused' }

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

/**
 * The registry `bot add` may write itself once the service is known to be down: a native install's
 * or, with nothing installed, the one next to the config. Undefined for a container, whose
 * registry lives in its volume.
 */
function findRegistryConfigPath(endpoint: LocalAdminEndpoint): string | undefined {
  if (endpoint.install !== undefined && !isNativeInstall(endpoint.install)) {
    return undefined
  }
  return endpoint.configPath
}

/** Prints why the stopped local service can't take the bot and returns `refused`. */
function refuseStopped(endpoint: LocalAdminEndpoint, deps: AdminDeps): AddRoute {
  const name = endpoint.install === undefined ? 'jaypost' : endpoint.install.target
  deps.printError(
    `The ${name} service isn't running. Start it first, then run jaypost bot add again.`,
  )
  return { kind: 'refused' }
}

/**
 * Decides before asking for any setting: the API when the service answers, the registry file when
 * a local service that runs from this machine's files is down, else refused (reason printed).
 */
async function chooseAddRoute(opened: OpenedAdmin, deps: AdminDeps): Promise<AddRoute> {
  if (opened.kind === 'failed') {
    deps.printError(opened.message)
    return { kind: 'refused' }
  }
  if (opened.kind === 'noKey') {
    const configPath = findRegistryConfigPath(opened.endpoint)
    const status = await deps.fetchStatus(opened.endpoint.port, undefined)
    if (configPath === undefined || status.kind !== 'unreachable') {
      deps.printError(opened.message)
      return { kind: 'refused' }
    }
    return { kind: 'registry', configPath }
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
  const configPath = findRegistryConfigPath(endpoint)
  return configPath === undefined ? refuseStopped(endpoint, deps) : { kind: 'registry', configPath }
}

/**
 * Adds the bot to the registry file next to `configPath`, for a service that isn't running.
 * Refuses while the registry has no seed but a config file exists: the service would then seed
 * its first bot under a later id, so it has to start once first. Returns the exit code.
 */
function addBotToRegistry(
  configPath: string,
  provider: Provider,
  settings: SettingValues,
  args: BotAddArgs,
  deps: AdminDeps,
): number {
  const store = new RegistryStore(resolveRegistryPath(configPath))
  const registry = store.load()
  if (registry.seed === undefined && existsSync(configPath)) {
    deps.printError(
      "The service isn't running and hasn't set up its registry yet. Start it once, then run jaypost bot add again.",
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
 * registry file instead; a stopped container has to be started first. Returns 0, 1 on failure,
 * 130 on Ctrl-C. The bot token is never printed.
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
    if (route.kind === 'registry') {
      return addBotToRegistry(route.configPath, provider, settings, args, deps)
    }
    const result = await route.caller.addBot({
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
