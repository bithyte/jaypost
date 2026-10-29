// `pnpm dev`: runs the service from source, restarting on every save. It keeps clear of a real
// install: it listens on 8788 and keeps each chat app's config, state and question log in
// .dev/<provider>/. It asks which chat app to use first; Terminal needs nothing, Telegram and
// Discord ask for your bot's token once. JAYPOST_PROVIDER, JAYPOST_BOT_TOKEN or JAYPOST_CONFIG (in the
// env or .env) skip the questions.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createClackPrompts,
  PromptAborted,
  resolveProviderSettings,
  selectProvider,
} from '../src/commands/index.ts'
import { PORT_ENV_VAR, PROVIDER_ENV_VAR, readConfigFile, updateConfigFile } from '@jaypost/store'
import { collectSettings, DEFAULT_PROVIDER, findProvider, requireProvider } from '@jaypost/core'
import { SERVICE_PROVIDERS } from '@jaypost/providers'

const DEV_PORT = '8788'
const FIRST_RUN_PROVIDER = 'terminal'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const devDirectory = join(root, '.dev')
const lastChoiceFile = join(devDirectory, 'dev.json')

/** Env value, with an empty string (like `JAYPOST_BOT_TOKEN=` in .env) counting as unset. */
function findEnv(key: string): string | undefined {
  const value = process.env[key]
  return value === '' ? undefined : value
}

function resolveConfigFile(providerName: string): string {
  return join(devDirectory, providerName, 'config.json')
}

/** The provider picked on the last run, or Terminal when there's no usable record of one. */
function readLastChoice(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lastChoiceFile, 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'provider' in parsed &&
      typeof parsed.provider === 'string' &&
      findProvider(SERVICE_PROVIDERS, parsed.provider) !== undefined
    ) {
      return parsed.provider
    }
  } catch {
    // Missing or corrupt: same as no last choice.
  }
  return FIRST_RUN_PROVIDER
}

/** Asks for the provider and its settings and saves both; the provider's name, or an exit code. */
async function setUp(signal: AbortSignal): Promise<string | number> {
  const prompt = createClackPrompts(signal)
  const last = readLastChoice()
  let provider = requireProvider(SERVICE_PROVIDERS, last)
  if (process.stdin.isTTY) {
    provider = (await selectProvider(SERVICE_PROVIDERS, prompt.select, last)) ?? provider
  } else {
    console.log(`Not a terminal, so not asking: using ${provider.label}.`)
  }
  const configFile = resolveConfigFile(provider.name)
  const file = readConfigFile(configFile)
  const resolved = await resolveProviderSettings({
    provider,
    saved: collectSettings(provider, (setting) => file[setting.configKey]),
    prompt,
    print: (text) => console.log(text),
    signal,
    seen: [],
  })
  if (resolved.kind === 'rejected') {
    return 1
  }
  updateConfigFile(configFile, { provider: provider.name, ...resolved.settings })
  writeFileSync(lastChoiceFile, `${JSON.stringify({ provider: provider.name }, null, 2)}\n`)
  return provider.name
}

async function runSetUp(): Promise<string | number> {
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  try {
    return await setUp(controller.signal)
  } catch (error) {
    if (error instanceof PromptAborted && !controller.signal.aborted && !process.stdin.isTTY) {
      console.error(
        'dev: no saved bot token works; run `pnpm dev` in a terminal or set JAYPOST_BOT_TOKEN',
      )
      return 1
    }
    if (error instanceof PromptAborted || controller.signal.aborted) {
      return 130
    }
    console.error(`dev: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    process.off('SIGINT', onSignal)
    // Stop reading so the service's terminal provider gets every keystroke.
    process.stdin.pause()
  }
}

/** The service's env, or an exit code when setup stopped. */
async function resolveServiceEnv(): Promise<NodeJS.ProcessEnv | number> {
  const base = { ...process.env, [PORT_ENV_VAR]: port }
  // Used as is: it may be a real install's config, so dev never writes to it.
  if (findEnv('JAYPOST_CONFIG') !== undefined) {
    return base
  }
  if (findEnv(PROVIDER_ENV_VAR) !== undefined || findEnv('JAYPOST_BOT_TOKEN') !== undefined) {
    return {
      ...base,
      JAYPOST_CONFIG: resolveConfigFile(findEnv(PROVIDER_ENV_VAR) ?? DEFAULT_PROVIDER),
    }
  }
  const chosen = await runSetUp()
  if (typeof chosen === 'number') {
    return chosen
  }
  return { ...base, JAYPOST_CONFIG: resolveConfigFile(chosen), [PROVIDER_ENV_VAR]: chosen }
}

try {
  process.loadEnvFile(join(root, '.env'))
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
    throw error
  }
}
const port = findEnv(PORT_ENV_VAR) ?? DEV_PORT
const serviceEnv = await resolveServiceEnv()
if (typeof serviceEnv === 'number') {
  process.exit(serviceEnv)
}
console.log(`try it from another terminal: pnpm cli test --port ${port}`)
const child = spawn(process.execPath, ['--watch', 'apps/cli/src/cli.ts', 'service', 'run'], {
  cwd: root,
  stdio: 'inherit',
  env: serviceEnv,
})
// Ctrl+C reaches the child too; wait for it to shut down instead of exiting first.
process.on('SIGINT', () => undefined)
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))
