#!/usr/bin/env node
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import {
  APPROVERS_ENV_VAR,
  DEFAULT_PORT,
  isPortFree,
  loadConfig,
  loadServiceConfig,
  MODE_ENV_VAR,
  parseSince,
  PORT_ENV_VAR,
  realExec,
  resolveClientToken,
  resolveConfigDirectory,
  resolveTokenFile,
} from '@jaypost/store'
import {
  DEFAULT_PROVIDER,
  MAX_RETRY_COUNT,
  MESSAGE_FORMATS,
  type Provider,
  requireProvider,
  resolveMaxAttachmentBytes,
  VOTE_RULES,
} from '@jaypost/core'
import type { MessageFormat, VoteRule } from '@jaypost/core'
import { DEFAULT_ATTACHMENT_NAME } from '@jaypost/client'
import type { AttachmentSource } from '@jaypost/client'
import {
  createClackPrompts,
  defaultFetchStatus,
  runAdminKeyRotate,
  runAdminKeyShow,
  runBotAdd,
  runBotList,
  runBotRemove,
  runFinishUpdate,
  runAudit,
  runDirectSendNotify,
  runDirectSendRequest,
  runInit,
  runKeyCreate,
  runKeyLabel,
  runKeyList,
  runKeyRevoke,
  runLog,
  runOwner,
  runPairApprover,
  runPairingCreate,
  runPairingList,
  runPairingRemove,
  runPing,
  runResetOwner,
  runSendNotify,
  runSendRequest,
  runSetupCi,
  runStatus,
  runUninstall,
  runUpdate,
  runWithSignals,
  waitForPairing,
  writeAll,
} from './commands/index.ts'
import { createProgress, formatOnRail, resolveProgressMode } from './progress/index.ts'
import type { Progress } from './progress/index.ts'
import type {
  AdminDeps,
  DirectSendDeps,
  InitArgs,
  LogArgs,
  PairApproverArgs,
  SendDeps,
  SendRequestArgs,
  SetupCiArgs,
} from './commands/index.ts'
import { formatOpenApiYaml, resolveApprovers, resolveSendMode, runService } from '@jaypost/service'
import type { SendMode } from '@jaypost/service'
import { readHookInput, runHook, STOP_DIRECTORY_NAME } from '@jaypost/hook'
import type { HookDeps } from '@jaypost/hook'
import {
  createTargets,
  NPM_LATEST_URL,
  readInstall,
  RELEASES_API_URL,
  resolveInstallPaths,
  resolveTargetOrder,
} from '@jaypost/install'
import { resolveMcpEndpoint, resolveMcpPort, runMcp } from '@jaypost/mcp'
import type { CliLocation, InstallPaths, Target, TargetName } from '@jaypost/install'
import { PROVIDERS, SERVICE_PROVIDERS } from '@jaypost/providers'
import { VERSION } from './constants.ts'

const DIGITS_PATTERN = /^\d+$/

function resolvePort(): number {
  try {
    return loadServiceConfig(process.env).port
  } catch {
    const port = Number(process.env[PORT_ENV_VAR])
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT
  }
}

function parsePort(rawPort: string): number {
  const port = DIGITS_PATTERN.test(rawPort) ? Number(rawPort) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('must be an integer 1-65535')
  }
  return port
}

function parseTimeout(rawTimeout: string): number {
  const timeout = Number(rawTimeout)
  if (rawTimeout.trim() === '' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new InvalidArgumentError('must be a positive number of seconds')
  }
  return timeout
}

function parseRetry(rawRetry: string): number {
  const retry = DIGITS_PATTERN.test(rawRetry) ? Number(rawRetry) : NaN
  if (!Number.isInteger(retry) || retry > MAX_RETRY_COUNT) {
    throw new InvalidArgumentError(`must be an integer 0-${MAX_RETRY_COUNT}`)
  }
  return retry
}

function parseSinceOption(raw: string): Date {
  const since = parseSince(raw, new Date())
  if (since === undefined || Number.isNaN(since.getTime())) {
    throw new InvalidArgumentError(
      'must be a duration like 12h, a date like 2026-10-18, or an ISO date-time',
    )
  }
  return since
}

function parseProjectOption(raw: string): string {
  const project = raw.trim()
  if (project === '') {
    throw new InvalidArgumentError('must not be empty')
  }
  return project
}

function parseLimit(raw: string): number {
  const limit = DIGITS_PATTERN.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new InvalidArgumentError('must be a positive integer')
  }
  return limit
}

function collect(value: string, previous: readonly string[] | undefined): readonly string[] {
  return [...(previous ?? []), value]
}

/** The `-o` labels, plus `-d` as the last button unless one names it or text replies are allowed. */
function toButtons(
  options: readonly string[],
  defaultAnswer: string,
  allowText: boolean | undefined,
): readonly string[] {
  if (allowText === true || options.includes(defaultAnswer)) {
    return options
  }
  return [...options, defaultAnswer]
}

/** The `--attach` source: `-` reads stdin, anything else is a path. */
function toAttachmentSource(
  attach: string | undefined,
  attachName: string | undefined,
): AttachmentSource | undefined {
  if (attach === undefined) {
    return undefined
  }
  if (attach === '-') {
    return {
      stream: process.stdin,
      name: attachName ?? DEFAULT_ATTACHMENT_NAME,
    }
  }
  return {
    path: attach,
    ...(attachName === undefined ? {} : { name: attachName }),
  }
}

let isStderrErrorHandled = false

/** A stderr checklist; `fallback` is the mode when no flag or env decides (silent by default). */
function createStderrProgress(fallback: 'plain' | 'silent' = 'silent'): Progress {
  if (!isStderrErrorHandled) {
    isStderrErrorHandled = true
    // A closed terminal or pipe (EPIPE, EIO) arrives as an async 'error' event that the renderer's
    // try/catch can't see, and an unhandled one kills the process mid-command.
    process.stderr.on('error', () => {})
  }
  const mode = resolveProgressMode(process.stderr, process.env, fallback)
  return createProgress({ stream: process.stderr, mode, env: process.env })
}

// stdout on a terminal too means nobody captures the answer, so it can sit on the checklist rail.
// Piped or captured, it stays bare for scripts.
function createAnswerPrint(progress: Progress): (text: string) => void {
  if (progress.mode !== 'live' || process.stdout.isTTY !== true) {
    return (text) => console.log(text)
  }
  const useColor = (process.env.NO_COLOR ?? '') === ''
  return (text) => console.log(formatOnRail(text, useColor))
}

function createSendDeps(
  flagPort: number | undefined,
  signal: AbortSignal,
  progress: Progress,
): SendDeps {
  return {
    endpoint: resolveMcpEndpoint(flagPort, process.env, resolveInstallPaths().installFile),
    token: resolveClientToken(process.env, resolveTokenFile(process.env)),
    signal,
    print: createAnswerPrint(progress),
    printError: (text) => console.error(text),
    progress,
    providers: PROVIDERS,
  }
}

function createDirectSendDeps(signal: AbortSignal, progress: Progress): DirectSendDeps {
  return {
    env: process.env,
    providers: PROVIDERS,
    signal,
    print: createAnswerPrint(progress),
    printError: (text) => console.error(text),
    progress,
  }
}

/** The send mode from `JAYPOST_MODE`; an unknown value is a usage error (exit 2). */
function requireSendMode(command: Command): Exclude<SendMode, { readonly kind: 'invalid' }> {
  const mode = resolveSendMode(process.env)
  if (mode.kind === 'invalid') {
    command.error(
      `error: ${MODE_ENV_VAR} must be "direct" or "service", got ${JSON.stringify(mode.value)}`,
      { exitCode: 2 },
    )
  }
  return mode
}

function createHookDeps(flagPort: number | undefined, signal: AbortSignal): HookDeps {
  return {
    endpoint: resolveMcpEndpoint(flagPort, process.env, resolveInstallPaths().installFile),
    token: resolveClientToken(process.env, resolveTokenFile(process.env)),
    signal,
    readInput: () => readHookInput(process.stdin, signal),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    env: process.env,
    stopDirectory: join(resolveConfigDirectory(process.env), STOP_DIRECTORY_NAME),
  }
}

function resolveOpenApiProvider(): Provider {
  try {
    return loadConfig(process.env, SERVICE_PROVIDERS).provider
  } catch {
    return requireProvider(PROVIDERS, DEFAULT_PROVIDER)
  }
}

function runOpenApiCommand(file: string | undefined, flagPort: number | undefined): number {
  const provider = resolveOpenApiProvider()
  const yaml = formatOpenApiYaml({
    version: VERSION,
    port: resolveMcpPort(flagPort, process.env, resolveInstallPaths().installFile),
    maxTextLength: provider.maxTextLength,
    maxAttachmentBytes: resolveMaxAttachmentBytes(provider),
    ...(provider.maxOptionCount === undefined ? {} : { maxOptionCount: provider.maxOptionCount }),
  })
  if (file === undefined) {
    process.stdout.write(yaml)
    return 0
  }
  try {
    writeFileSync(file, yaml)
  } catch (error) {
    console.error(
      `couldn't write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
  return 0
}

/** This machine's IANA zone, or undefined when Intl can't tell. */
function findTimeZone(): string | undefined {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timeZone && timeZone !== 'Etc/Unknown' ? timeZone : undefined
}

function runInitCommand(args: InitArgs): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  const timeZone = findTimeZone()
  return runWithSignals(
    (controller) =>
      runInit(args, {
        targets,
        paths,
        prompt: createClackPrompts(controller.signal),
        providers: PROVIDERS,
        isPortFree,
        wait: waitForPairing,
        progress: createStderrProgress('plain'),
        signal: controller.signal,
        version: VERSION,
        ...(timeZone === undefined ? {} : { timeZone }),
      }),
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

function runSetupCiCommand(args: SetupCiArgs): Promise<number> {
  return runWithSignals(
    (controller) => {
      const progress = createStderrProgress('plain')
      return runSetupCi(args, {
        prompt: createClackPrompts(controller.signal),
        providers: PROVIDERS,
        print: (text) => console.log(text),
        progress,
        log: progress.note,
        signal: controller.signal,
      })
    },
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

function runPairApproverCommand(args: PairApproverArgs): Promise<number> {
  return runWithSignals(
    (controller) => {
      const progress = createStderrProgress('plain')
      return runPairApprover(args, {
        prompt: createClackPrompts(controller.signal),
        providers: PROVIDERS,
        print: (text) => console.log(text),
        progress,
        log: progress.note,
        signal: controller.signal,
      })
    },
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

function createRealTargets(paths: InstallPaths): Readonly<Record<TargetName, Target>> {
  const userInfo = os.userInfo()
  return createTargets(
    {
      exec: realExec,
      paths,
      env: process.env,
      user: userInfo.username,
      providers: PROVIDERS,
      platform: process.platform,
      uid: userInfo.uid,
    },
    resolveCliLocation(),
  )
}

/** The standalone binary itself when running as one, else this npm CLI script and its node. */
function resolveCliLocation(): CliLocation {
  if (isSea()) {
    return { kind: 'binary', binaryPath: process.execPath }
  }
  return {
    kind: 'npm',
    selfPath: realpathSync(fileURLToPath(import.meta.url)),
    nodePath: process.execPath,
  }
}

const LIVE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** Setup commands: Ctrl-C keeps exit 130; SIGTERM re-raises once the running step is cancelled. */
const SETUP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const SETUP_RERAISED = ['SIGTERM'] as const

function runSendRequestWithSignals(args: SendRequestArgs, flagPort: number | undefined) {
  const progress = createStderrProgress()
  if (progress.mode !== 'live') {
    return runWithSignals((controller) =>
      runSendRequest(args, createSendDeps(flagPort, controller.signal, progress)),
    )
  }
  return runWithSignals(
    (controller) => runSendRequest(args, createSendDeps(flagPort, controller.signal, progress)),
    LIVE_SIGNALS,
    ['SIGTERM', 'SIGHUP'],
  )
}

// A cancelled CI run sends SIGTERM; the question is still edited to the cancelled line and the
// command exits with its own code. A closed terminal (SIGHUP) only stops the live countdown, so
// it is re-raised for the default status.
function runDirectSendRequestWithSignals(args: SendRequestArgs): Promise<number> {
  const progress = createStderrProgress()
  return runWithSignals(
    (controller) => runDirectSendRequest(args, createDirectSendDeps(controller.signal, progress)),
    progress.mode === 'live' ? LIVE_SIGNALS : ['SIGINT', 'SIGTERM'],
    progress.mode === 'live' ? ['SIGHUP'] : [],
  )
}

function runStatusCommand(): Promise<number> {
  const tokenFile = resolveTokenFile(process.env)
  const paths = resolveInstallPaths()
  return runStatus({
    targets: createRealTargets(paths),
    paths,
    fetchStatus: defaultFetchStatus,
    token: resolveClientToken(process.env, tokenFile),
    tokenFile,
    print: (text) => console.log(text),
  })
}

function runLogCommand(args: LogArgs): Promise<number> {
  const paths = resolveInstallPaths()
  return runLog(args, {
    targets: createRealTargets(paths),
    paths,
    env: process.env,
    token: resolveClientToken(process.env, resolveTokenFile(process.env)),
    version: VERSION,
    now: () => new Date(),
    print: (text) => writeAll(`${text}\n`),
    printError: (text) => console.error(text),
  })
}

function runResetOwnerCommand(): Promise<number> {
  const token = resolveClientToken(process.env, resolveTokenFile(process.env))
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSignals(
    (controller) =>
      runResetOwner({
        targets,
        paths,
        providers: PROVIDERS,
        confirm: createClackPrompts(controller.signal).confirm,
        wait: waitForPairing,
        progress: createStderrProgress('plain'),
        signal: controller.signal,
        token,
        fetchStatus: defaultFetchStatus,
      }),
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

function runUninstallCommand(): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSignals(
    (controller) =>
      runUninstall({
        targets,
        paths,
        confirm: createClackPrompts(controller.signal).confirm,
        progress: createStderrProgress('plain'),
        signal: controller.signal,
      }),
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

function runUpdateCommand(isFinish: boolean): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  const timeZone = findTimeZone()
  return runWithSignals(
    (controller) => {
      const deps = {
        targets,
        paths,
        providers: PROVIDERS,
        exec: realExec,
        cli: resolveCliLocation(),
        version: VERSION,
        platform: process.platform,
        arch: process.arch,
        releasesUrl: RELEASES_API_URL,
        npmLatestUrl: NPM_LATEST_URL,
        progress: createStderrProgress('plain'),
        signal: controller.signal,
        ...(timeZone === undefined ? {} : { timeZone }),
      }
      return isFinish ? runFinishUpdate(deps) : runUpdate(deps)
    },
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

/** What the admin commands use; prompts abort with `signal`. */
function createAdminDeps(signal?: AbortSignal): AdminDeps {
  const paths = resolveInstallPaths()
  return {
    env: process.env,
    paths,
    targets: createRealTargets(paths),
    providers: PROVIDERS,
    prompt: createClackPrompts(signal),
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
    fetchStatus: defaultFetchStatus,
    ...(signal === undefined ? {} : { signal }),
  }
}

/** Runs an admin command that may prompt, so Ctrl-C ends the prompt with exit 130. */
function runPromptingAdminCommand(run: (deps: AdminDeps) => Promise<number>): Promise<number> {
  return runWithSignals(
    (controller) => run(createAdminDeps(controller.signal)),
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

/** The bot, key, pairing and admin-key commands, which call the admin routes. */
function addAdminCommands(program: Command, setCode: (code: number) => void): void {
  const jsonHelp = 'print the answer as JSON'
  const bot = program.command('bot').description("add, list and remove the service's bots")
  bot
    .command('add')
    .description('add a bot; asks for its settings')
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    .option('--label <text>', 'a name for the bot')
    .option('--json', jsonHelp)
    .action(
      async (options: {
        readonly provider?: string
        readonly label?: string
        readonly json?: boolean
      }) => {
        setCode(await runPromptingAdminCommand((deps) => runBotAdd(options, deps)))
      },
    )
  bot
    .command('list')
    .description('show the bots with their state, pairings and keys')
    .option('--json', jsonHelp)
    .action(async (options: { readonly json?: boolean }) => {
      setCode(await runBotList(options, createAdminDeps()))
    })
  bot
    .command('remove')
    .description('remove a bot with its pairings and keys')
    .argument('<id>', 'bot id, such as b2')
    .option('-y, --yes', "don't ask first")
    .option('--json', jsonHelp)
    .action(async (id: string, options: { readonly yes?: boolean; readonly json?: boolean }) => {
      setCode(await runPromptingAdminCommand((deps) => runBotRemove({ id, ...options }, deps)))
    })
  const key = program.command('key').description('create, list, label and revoke API keys')
  key
    .command('create')
    .description('create an API key and print it once')
    .option('--bot <id>', 'for a new pairing on this bot, with a pairing code')
    .option('--pairing <id>', 'for this existing pairing')
    .option('--same-as <key id>', 'for the pairing of this key')
    .option('--label <text>', 'a free-form label')
    .option('--external-id <id>', 'a free-form id from another system')
    .option('--json', jsonHelp)
    .action(
      async (options: {
        readonly bot?: string
        readonly pairing?: string
        readonly sameAs?: string
        readonly label?: string
        readonly externalId?: string
        readonly json?: boolean
      }) => {
        setCode(await runKeyCreate(options, createAdminDeps()))
      },
    )
  key
    .command('list')
    .description("show the keys (never the keys' values)")
    .option('--bot <id>', "only this bot's keys")
    .option('--pairing <id>', "only this pairing's keys")
    .option('--json', jsonHelp)
    .action(
      async (options: {
        readonly bot?: string
        readonly pairing?: string
        readonly json?: boolean
      }) => {
        setCode(await runKeyList(options, createAdminDeps()))
      },
    )
  key
    .command('label')
    .description("set or clear a key's label and external id")
    .argument('<id>', 'key id, such as k2')
    .option('--label <text>', 'the new label; "" clears it')
    .option('--external-id <id>', 'the new external id; "" clears it')
    .option('--json', jsonHelp)
    .action(
      async (
        id: string,
        options: { readonly label?: string; readonly externalId?: string; readonly json?: boolean },
      ) => {
        setCode(await runKeyLabel({ id, ...options }, createAdminDeps()))
      },
    )
  key
    .command('revoke')
    .description('revoke a key; its pairing stays')
    .argument('<id>', 'key id, such as k2')
    .option('--json', jsonHelp)
    .action(async (id: string, options: { readonly json?: boolean }) => {
      setCode(await runKeyRevoke({ id, ...options }, createAdminDeps()))
    })
  const pairing = program
    .command('pairing')
    .description('create, list and remove pairings between a bot and a person')
  pairing
    .command('create')
    .description('create a pairing with no key (an approver) and print its code')
    .requiredOption('--bot <id>', 'the bot to pair with')
    .option('--json', jsonHelp)
    .action(async (options: { readonly bot: string; readonly json?: boolean }) => {
      setCode(await runPairingCreate(options, createAdminDeps()))
    })
  pairing
    .command('list')
    .description('show the pairings and the codes of pending ones')
    .option('--bot <id>', "only this bot's pairings")
    .option('--json', jsonHelp)
    .action(async (options: { readonly bot?: string; readonly json?: boolean }) => {
      setCode(await runPairingList(options, createAdminDeps()))
    })
  pairing
    .command('remove')
    .description('remove a pairing and revoke its keys')
    .argument('<id>', 'pairing id, such as p2')
    .option('-y, --yes', "don't ask first")
    .option('--json', jsonHelp)
    .action(async (id: string, options: { readonly yes?: boolean; readonly json?: boolean }) => {
      setCode(await runPromptingAdminCommand((deps) => runPairingRemove({ id, ...options }, deps)))
    })
  const adminKey = program.command('admin-key').description('rotate the admin key')
  adminKey
    .command('rotate')
    .description('replace the admin key and print the new one')
    .option('--json', jsonHelp)
    .action(async (options: { readonly json?: boolean }) => {
      setCode(await runAdminKeyRotate(options, createAdminDeps()))
    })
  // Runs inside containers to print the admin key from the data volume.
  adminKey.command('show', { hidden: true }).action(() => {
    setCode(
      runAdminKeyShow(
        process.env,
        (text) => console.log(text),
        (text) => console.error(text),
      ),
    )
  })
}

/** Maps the old `send request`, `send notify` and `test` spellings so existing scripts keep working. */
function toCurrentArgv(argv: readonly string[]): readonly string[] {
  const [first, second] = argv
  if (first === 'send' && (second === 'request' || second === 'notify')) {
    return argv.slice(1)
  }
  if (first === 'test') {
    return ['ping', ...argv.slice(1)]
  }
  return argv
}

/** Takes argv without node and script path; returns the exit code (2 for usage errors). */
export async function main(argv: readonly string[]): Promise<number> {
  let code = 0
  const program = new Command('jaypost').version(VERSION, '-v, --version').exitOverride()
  program
    .command('init')
    .description('set up the bot token and install the service')
    .addArgument(new Argument('[target]').choices(resolveTargetOrder(process.platform)))
    .option('--port <n>', "API port (default 8787, or the existing install's)", parsePort)
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    .option('--token', 'require an API token (default for new setups)')
    .option('--no-token', "don't require an API token")
    // Installs an unpublished build; for testing.
    .addOption(new Option('--tarball <path>').hideHelp())
    .action(
      async (
        target: TargetName | undefined,
        options: {
          readonly port?: number
          readonly tarball?: string
          readonly provider?: string
          readonly token?: boolean
        },
      ) => {
        code = await runInitCommand({
          ...(target ? { target } : {}),
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          ...(options.token === undefined ? {} : { token: options.token }),
          ...(options.tarball === undefined ? {} : { tarball: resolve(options.tarball) }),
        })
      },
    )
  program
    .command('setup-ci')
    .description('pair an owner for CI and print the env vars for direct mode')
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    .action(async (options: { readonly provider?: string }) => {
      code = await runSetupCiCommand(
        options.provider === undefined ? {} : { provider: options.provider },
      )
    })
  const pair = program.command('pair').description('pair someone with the bot for CI')
  pair
    .command('approver')
    .description('pair approvers for direct mode votes and print their ids')
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    .action(async (options: { readonly provider?: string }) => {
      code = await runPairApproverCommand(
        options.provider === undefined ? {} : { provider: options.provider },
      )
    })
  program
    .command('start')
    .description('run the service in the foreground')
    .action(() => runService(VERSION))
  program
    .command('status')
    .description('show service and pairing state')
    .action(async () => {
      code = await runStatusCommand()
    })
  program
    .command('log')
    .description('show the questions the service asked and how they ended')
    .option(
      '--since <when>',
      'only newer questions: 12h, 7d, 2026-10-18 or an ISO date-time',
      parseSinceOption,
    )
    .option('--project <name>', 'only questions from this project', parseProjectOption)
    .option('-n, --limit <n>', 'show the last N (default 20, or all with --since)', parseLimit)
    .option('--json', 'print one JSON entry per line')
    .option('--bot <id>', "only this bot's questions; reads through the API")
    .option('--pairing <id>', "only this pairing's questions; reads through the API")
    .option('--key <id>', "only this key's questions; reads through the API")
    .option('--all', "every bot's questions, not only the first bot's; reads through the API")
    .action(
      async (options: {
        readonly since?: Date
        readonly project?: string
        readonly limit?: number
        readonly json?: boolean
        readonly bot?: string
        readonly pairing?: string
        readonly key?: string
        readonly all?: boolean
      }) => {
        code = await runLogCommand({
          ...(options.since === undefined ? {} : { since: options.since }),
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.json === undefined ? {} : { json: options.json }),
          ...(options.bot === undefined ? {} : { bot: options.bot }),
          ...(options.pairing === undefined ? {} : { pairing: options.pairing }),
          ...(options.key === undefined ? {} : { key: options.key }),
          ...(options.all === undefined ? {} : { all: options.all }),
        })
      },
    )
  program
    .command('ping')
    .description('send a test message to check the service and pairing')
    .option(
      '--port <n>',
      'API port (default: the install, then JAYPOST_PORT, then 8787)',
      parsePort,
    )
    .action(async (options: { readonly port?: number }) => {
      const port =
        options.port ?? readInstall(resolveInstallPaths().installFile)?.port ?? resolvePort()
      const progress = createStderrProgress()
      const runLive = (controller: AbortController) =>
        runPing({
          port,
          token: resolveClientToken(process.env, resolveTokenFile(process.env)),
          progress,
          providers: PROVIDERS,
          signal: controller.signal,
          print: createAnswerPrint(progress),
          printError: (text) => console.error(text),
        })
      // Off a terminal there's no signal handler, as before: a signal ends the process.
      code =
        progress.mode === 'live'
          ? await runWithSignals(runLive, LIVE_SIGNALS, LIVE_SIGNALS)
          : await runLive(new AbortController())
    })
  program
    .command('reset-owner')
    .description('clear the paired owner so a new one can pair')
    .action(async () => {
      code = await runResetOwnerCommand()
    })
  program
    .command('uninstall')
    .description('remove the service')
    .action(async () => {
      code = await runUninstallCommand()
    })
  program
    .command('update')
    .description('update the service or this CLI to the latest release')
    // Run by the new CLI after `update` fetched it, to rewrite the install's files.
    .addOption(new Option('--finish').hideHelp())
    .action(async (options: { readonly finish?: boolean }) => {
      code = await runUpdateCommand(options.finish === true)
    })
  program
    .command('mcp')
    .description('run an MCP server on stdin/stdout for agents')
    .option(
      '--port <n>',
      'API port on this machine, overrides JAYPOST_URL (default: JAYPOST_PORT, then the install, then 8787)',
      parsePort,
    )
    .action(async (options: { readonly port?: number }) => {
      // Not resolvePort(): that reads config.json, which an agent's container may not have.
      const tokenFile = resolveTokenFile(process.env)
      code = await runMcp({
        version: VERSION,
        endpoint: resolveMcpEndpoint(options.port, process.env, resolveInstallPaths().installFile),
        readToken: () => resolveClientToken(process.env, tokenFile),
      })
    })
  program
    .command('openapi')
    .description('print the OpenAPI spec of the HTTP API, or write it to a file')
    .argument('[file]', 'file to write; prints to stdout without one')
    .option(
      '--port <n>',
      'API port on this machine, overrides JAYPOST_URL (default: JAYPOST_PORT, then the install, then 8787)',
      parsePort,
    )
    .action((file: string | undefined, options: { readonly port?: number }) => {
      code = runOpenApiCommand(file, options.port)
    })
  const request = program
    .command('request')
    .description('ask a question and print the answer')
    .argument('<text>', 'question to show')
    .option(
      '-o, --option <label>',
      'button label, repeat for each button; required unless --allow-text',
      collect,
    )
    .option('--allow-text', 'let the owner answer by replying with text')
    .requiredOption(
      '-d, --default <label>',
      'answer printed on timeout; added as the last button unless an -o already names it or --allow-text is set',
    )
    .option(
      '--timeout <seconds>',
      'seconds to wait; default 300, max 86400 (24 h); longer values are capped',
      parseTimeout,
    )
    .option(
      '-u, --user <id>',
      'send to this paired user instead of the owner; repeat per approver; overrides JAYPOST_APPROVERS',
      collect,
    )
    .addOption(
      new Option('--require <rule>', 'votes needed to approve: all or majority').choices(
        VOTE_RULES,
      ),
    )
    .option('--retry <count>', 're-ask up to N times after a timeout', parseRetry)
    .option('--project <name>', 'shown as [name] above the question')
    .addOption(
      new Option('--format <format>', 'how to read TEXT: plain (default) or markdown').choices(
        MESSAGE_FORMATS,
      ),
    )
    .option(
      '--json',
      'print {"answer":...,"timedOut":...} instead of the answer; a vote adds the tally',
    )
    .option('--attach <file>', 'attach a file; "-" reads stdin')
    .option(
      '--attach-name <name>',
      'file name shown in the chat app (default: the file\'s basename, "attachment.txt" for stdin)',
    )
    .option(
      '--port <n>',
      'API port on this machine, overrides JAYPOST_URL (default: JAYPOST_PORT, then the install, then 8787)',
      parsePort,
    )
    .action(
      async (
        text: string,
        options: {
          readonly option?: readonly string[]
          readonly allowText?: boolean
          readonly default: string
          readonly timeout?: number
          readonly user?: readonly string[]
          readonly require?: VoteRule
          readonly retry?: number
          readonly project?: string
          readonly format?: MessageFormat
          readonly json?: boolean
          readonly attach?: string
          readonly attachName?: string
          readonly port?: number
        },
      ) => {
        const mode = requireSendMode(request)
        const approvers = resolveApprovers(options.user, process.env)
        const isVote = approvers.kind === 'listed' || options.require !== undefined
        if (approvers.kind === 'empty') {
          request.error(
            `error: ${APPROVERS_ENV_VAR} is set but has no ids; a missing GitHub secret is empty too`,
            { exitCode: 2 },
          )
        }
        if (
          isVote &&
          (options.allowText === true ||
            options.option?.length !== 1 ||
            options.option[0] === options.default)
        ) {
          request.error(
            'error: a vote needs exactly one -o and a different -d, without --allow-text',
            {
              exitCode: 2,
            },
          )
        }
        if (options.attachName !== undefined && options.attach === undefined) {
          request.error("error: option '--attach-name <name>' needs '--attach <file>'", {
            exitCode: 2,
          })
        }
        const attachment = toAttachmentSource(options.attach, options.attachName)
        if (options.option === undefined && options.allowText !== true) {
          request.error("error: option '-o, --option <label>' or '--allow-text' is required", {
            exitCode: 2,
          })
        }
        const args = {
          text,
          ...(options.option === undefined
            ? {}
            : { options: toButtons(options.option, options.default, options.allowText) }),
          ...(options.allowText === undefined ? {} : { allowText: options.allowText }),
          timeoutOption: options.default,
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.format === undefined ? {} : { format: options.format }),
          ...(options.json === undefined ? {} : { json: options.json }),
          ...(attachment === undefined ? {} : { attachment }),
          ...(approvers.kind === 'listed' ? { voters: approvers.voters } : {}),
          ...(options.require === undefined ? {} : { rule: options.require }),
          ...(options.retry === undefined ? {} : { retryCount: options.retry }),
        }
        code =
          mode.kind === 'direct'
            ? await runDirectSendRequestWithSignals(args)
            : await runSendRequestWithSignals(args, options.port)
      },
    )
  const notify = program
    .command('notify')
    .description("send a message that doesn't need an answer")
    .argument('<text>', 'message to show')
    .option('--project <name>', 'shown as [name] above the message')
    .addOption(
      new Option('--format <format>', 'how to read TEXT: plain (default) or markdown').choices(
        MESSAGE_FORMATS,
      ),
    )
    .option('--attach <file>', 'attach a file; "-" reads stdin')
    .option(
      '--attach-name <name>',
      'file name shown in the chat app (default: the file\'s basename, "attachment.txt" for stdin)',
    )
    .option(
      '--port <n>',
      'API port on this machine, overrides JAYPOST_URL (default: JAYPOST_PORT, then the install, then 8787)',
      parsePort,
    )
    .action(
      async (
        text: string,
        options: {
          readonly project?: string
          readonly format?: MessageFormat
          readonly attach?: string
          readonly attachName?: string
          readonly port?: number
        },
      ) => {
        const mode = requireSendMode(notify)
        if (options.attachName !== undefined && options.attach === undefined) {
          notify.error("error: option '--attach-name <name>' needs '--attach <file>'", {
            exitCode: 2,
          })
        }
        const attachment = toAttachmentSource(options.attach, options.attachName)
        const args = {
          text,
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.format === undefined ? {} : { format: options.format }),
          ...(attachment === undefined ? {} : { attachment }),
        }
        code =
          mode.kind === 'direct'
            ? await runWithSignals(
                (controller) =>
                  runDirectSendNotify(
                    args,
                    createDirectSendDeps(controller.signal, createStderrProgress()),
                  ),
                ['SIGINT', 'SIGTERM'],
              )
            : await runWithSignals((controller) =>
                runSendNotify(
                  args,
                  createSendDeps(options.port, controller.signal, createStderrProgress()),
                ),
              )
      },
    )
  program
    .command('hook')
    .description(
      'answer Claude Code permission prompts, forward notifications and ask for the next prompt when Claude stops (reads a hook event on stdin)',
    )
    .option(
      '--port <n>',
      'API port on this machine, overrides JAYPOST_URL (default: JAYPOST_PORT, then the install, then 8787)',
      parsePort,
    )
    .option('--project <name>', 'shown as [name] (default: the Claude Code project folder)')
    .option(
      '--timeout <seconds>',
      'seconds to wait for an answer; default 300 (3600 for Stop), max 86400 (24 h); longer values are capped',
      parseTimeout,
    )
    .action(
      async (options: {
        readonly port?: number
        readonly project?: string
        readonly timeout?: number
      }) => {
        const args = {
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        }
        code = await runWithSignals(
          (controller) => runHook(args, createHookDeps(options.port, controller.signal)),
          ['SIGINT', 'SIGTERM'],
        )
      },
    )
  addAdminCommands(program, (adminCode) => {
    code = adminCode
  })
  // Runs inside containers to read or clear the owner in the data volume.
  program
    .command('owner', { hidden: true })
    .argument('[args...]')
    .action((args: string[]) => {
      code = runOwner(args)
    })
  // Runs inside containers to dump the audit log from the data volume.
  program
    .command('audit', { hidden: true })
    .argument('[args...]')
    .action((args: string[]) => {
      code = runAudit(args)
    })
  try {
    await program.parseAsync(argv.length === 0 ? ['--help'] : toCurrentArgv(argv), {
      from: 'user',
    })
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error
    }
    // Help and version exit 0; usage errors (already printed) exit 2.
    return error.exitCode === 0 ? 0 : 2
  }
  return code
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  // `start` keeps the process alive via the server and bot; only exit for other commands.
  if (process.argv[2] !== 'start') {
    process.exit(code)
  }
}
