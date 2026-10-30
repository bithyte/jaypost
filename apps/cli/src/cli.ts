#!/usr/bin/env node
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import {
  APPROVERS_ENV_VAR,
  isPortFree,
  loadConfig,
  MODE_ENV_VAR,
  parseSince,
  realExec,
  resolveInboxPath,
  resolveJaypostDirectory,
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
import { DEFAULT_ATTACHMENT_NAME, resolveBot } from '@jaypost/client'
import type { AttachmentSource } from '@jaypost/client'
import {
  createClackPrompts,
  defaultFetchStatus,
  runAdminKeyRotate,
  runAdminKeyShow,
  runAdminLog,
  runBotAdd,
  runBotList,
  runBotRemove,
  runFinishUpdate,
  runAudit,
  runDirectSendNotify,
  runDirectSendRequest,
  runInit,
  runContactAdd,
  runContactList,
  runContactRemove,
  runKeyCreate,
  runKeyRevoke,
  runLog,
  runOwner,
  runPairApprover,
  runPing,
  runInboxDefault,
  runInboxList,
  runInboxRemove,
  runInboxRename,
  runJoin,
  runRemoteAdd,
  runRemoteList,
  runRemoteRemove,
  runResetOwner,
  runSendNotify,
  runSendRequest,
  runServiceStart,
  runServiceStop,
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
  AdminLogArgs,
  InboxDeps,
  DirectSendDeps,
  InitArgs,
  LogArgs,
  PairApproverArgs,
  SendDeps,
  SendRequestArgs,
  ServiceControlDeps,
  SetupCiArgs,
} from './commands/index.ts'
import { formatOpenApiYaml, resolveApprovers, resolveSendMode, runService } from '@jaypost/service'
import type { SendMode } from '@jaypost/service'
import { readHookInput, runHook, STOP_DIRECTORY_NAME } from '@jaypost/hook'
import type { HookDeps } from '@jaypost/hook'
import {
  createTargets,
  NPM_LATEST_URL,
  findExistingInstall,
  RELEASES_API_URL,
  resolveInstallPaths,
  resolveTargetOrder,
} from '@jaypost/install'
import { resolveMcpPort, runMcp } from '@jaypost/mcp'
import type { CliLocation, InstallPaths, Target, TargetName } from '@jaypost/install'
import { PROVIDERS, SERVICE_PROVIDERS } from '@jaypost/providers'
import { VERSION } from './constants.ts'

const DIGITS_PATTERN = /^\d+$/

const BOT_FLAGS = '-b, --bot <alias>'

const JSON_HELP = 'print the answer as JSON'

const BOT_DESCRIPTION =
  'inbox bot to use (default: JAYPOST_BOT, then JAYPOST_URL/JAYPOST_TOKEN, then the inbox default)'

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
  bot: string | undefined,
  signal: AbortSignal,
  progress: Progress,
): SendDeps {
  const resolved = resolveBot(process.env, bot)
  return {
    endpoint: resolved.endpoint,
    token: resolved.token,
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

function createHookDeps(bot: string | undefined, signal: AbortSignal): HookDeps {
  const resolved = resolveBot(process.env, bot)
  return {
    endpoint: resolved.endpoint,
    token: resolved.token,
    signal,
    readInput: () => readHookInput(process.stdin, signal),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    env: process.env,
    stopDirectory: join(resolveJaypostDirectory(process.env), STOP_DIRECTORY_NAME),
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
        inboxPath: resolveInboxPath(process.env),
        hostname: os.hostname(),
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

function runSendRequestWithSignals(args: SendRequestArgs, bot: string | undefined) {
  const progress = createStderrProgress()
  if (progress.mode !== 'live') {
    return runWithSignals((controller) =>
      runSendRequest(args, createSendDeps(bot, controller.signal, progress)),
    )
  }
  return runWithSignals(
    (controller) => runSendRequest(args, createSendDeps(bot, controller.signal, progress)),
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

function runStatusCommand(bot: string | undefined): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  const existing = findExistingInstall(paths, targets)
  return runStatus({
    resolved: resolveBot(process.env, bot),
    install:
      existing === undefined
        ? undefined
        : { record: existing.record, target: targets[existing.record.target] },
    fetchStatus: defaultFetchStatus,
    print: (text) => console.log(text),
  })
}

function runLogCommand(args: LogArgs, bot: string | undefined): Promise<number> {
  const resolved = resolveBot(process.env, bot)
  return runLog(args, {
    endpoint: resolved.endpoint,
    token: resolved.token,
    print: (text) => writeAll(`${text}\n`),
    printError: (text) => console.error(text),
  })
}

function runResetOwnerCommand(): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSignals(
    (controller) =>
      runResetOwner({
        env: process.env,
        targets,
        paths,
        providers: PROVIDERS,
        confirm: createClackPrompts(controller.signal).confirm,
        wait: waitForPairing,
        progress: createStderrProgress('plain'),
        signal: controller.signal,
        inboxPath: resolveInboxPath(process.env),
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
        inboxPath: resolveInboxPath(process.env),
      }),
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

/** What `service start` and `service stop` use. */
function createServiceControlDeps(): ServiceControlDeps {
  const paths = resolveInstallPaths()
  return {
    paths,
    targets: createRealTargets(paths),
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
  }
}

/** The `service` group: install, uninstall, start, stop, run and update on this machine. */
function addServiceCommands(program: Command, setCode: (code: number) => void): void {
  const service = program
    .command('service')
    .description('install, remove, start, stop, run or update the service on this machine')
  service
    .command('install')
    .description('set up the bot token and install the service')
    .addArgument(new Argument('[target]').choices(resolveTargetOrder(process.platform)))
    .option('--port <n>', "API port (default 8787, or the existing install's)", parsePort)
    .option('--exposed', 'listen on all interfaces over plain http, not just this machine')
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
          readonly exposed?: boolean
          readonly tarball?: string
          readonly provider?: string
          readonly token?: boolean
        },
      ) => {
        setCode(
          await runInitCommand({
            ...(target ? { target } : {}),
            ...(options.port === undefined ? {} : { port: options.port }),
            ...(options.exposed === undefined ? {} : { exposed: options.exposed }),
            ...(options.provider === undefined ? {} : { provider: options.provider }),
            ...(options.token === undefined ? {} : { token: options.token }),
            ...(options.tarball === undefined ? {} : { tarball: resolve(options.tarball) }),
          }),
        )
      },
    )
  service
    .command('uninstall')
    .description('remove the service and its entries in the inbox')
    .action(async () => {
      setCode(await runUninstallCommand())
    })
  service
    .command('start')
    .description('start the installed service')
    .action(async () => {
      setCode(await runServiceStart(createServiceControlDeps()))
    })
  service
    .command('stop')
    .description('stop the installed service')
    .action(async () => {
      setCode(await runServiceStop(createServiceControlDeps()))
    })
  service
    .command('run')
    .description('run the service in the foreground')
    .action(() => runService(VERSION))
  service
    .command('update')
    .description('update the service or this CLI to the latest release')
    // Run by the new CLI after `service update` fetched it, to rewrite the install's files.
    .addOption(new Option('--finish').hideHelp())
    .action(async (options: { readonly finish?: boolean }) => {
      setCode(await runUpdateCommand(options.finish === true))
    })
}

/** What the `inbox` and `admin remote` commands use; prompts abort with `signal`. */
function createInboxDeps(signal?: AbortSignal): InboxDeps {
  return {
    inboxPath: resolveInboxPath(process.env),
    prompt: createClackPrompts(signal),
    isInteractive: process.stdin.isTTY === true,
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
  }
}

/** The `admin remote` group: services on other machines this one administers. */
function addAdminRemoteCommands(admin: Command, setCode: (code: number) => void): void {
  const remote = admin
    .command('remote')
    .description('add, list and remove services on other machines you administer')
  remote
    .command('add')
    .description('check the admin key against a service and save it as a remote')
    .argument('<name>', 'a short name for the remote')
    .argument('<url>', 'the service url')
    .argument('<admin-key>', "the service's admin key")
    .action(async (name: string, url: string, adminKey: string) => {
      setCode(
        await runWithSignals(
          (controller) => runRemoteAdd({ name, url, adminKey }, createInboxDeps(controller.signal)),
          SETUP_SIGNALS,
          SETUP_RERAISED,
        ),
      )
    })
  remote
    .command('remove')
    .description('forget a remote; its bots stay')
    .argument('<name>', 'the remote name')
    .action(async (name: string) => {
      setCode(await runRemoteRemove({ name }, createInboxDeps()))
    })
  remote
    .command('list')
    .description('show the remotes (names and urls, no keys)')
    .action(async () => {
      setCode(await runRemoteList(createInboxDeps()))
    })
}

/** The `inbox` group: the bots in your inbox; with no subcommand it lists them. */
function addInboxCommands(program: Command, setCode: (code: number) => void): void {
  const inbox = program
    .command('inbox')
    .description(
      'list the bots in your inbox, join one, or set the default, rename and remove them',
    )
    .action(async () => {
      setCode(await runInboxList(createInboxDeps()))
    })
  inbox
    .command('list')
    .description('show the bots (aliases and services, no keys)')
    .action(async () => {
      setCode(await runInboxList(createInboxDeps()))
    })
  inbox
    .command('join')
    .description('save a bot from an invite and wait for its pairing code')
    .argument('<invite>', 'the invite (jpi_...) the service owner sent you')
    .option('--as <alias>', 'save the bot under this alias')
    .action(async (invite: string, options: { readonly as?: string }) => {
      setCode(
        await runWithSignals(
          (controller) =>
            runJoin(
              { invite, ...(options.as === undefined ? {} : { as: options.as }) },
              {
                ...createInboxDeps(controller.signal),
                fetchStatus: defaultFetchStatus,
                wait: waitForPairing,
                progress: createStderrProgress('plain'),
                signal: controller.signal,
              },
            ),
          SETUP_SIGNALS,
          SETUP_RERAISED,
        ),
      )
    })
  inbox
    .command('default')
    .description('make a bot the default')
    .argument('<alias>', 'the bot alias')
    .action(async (alias: string) => {
      setCode(await runInboxDefault({ alias }, createInboxDeps()))
    })
  inbox
    .command('rename')
    .description('give a bot a new alias')
    .argument('<alias>', 'the current alias')
    .argument('<new-alias>', 'the new alias')
    .action(async (alias: string, newAlias: string) => {
      setCode(await runInboxRename({ alias, newAlias }, createInboxDeps()))
    })
  inbox
    .command('remove')
    .description('remove a bot from your inbox')
    .argument('<alias>', 'the bot alias')
    .option('-y, --yes', 'skip the confirmation')
    .action(async (alias: string, options: { readonly yes?: boolean }) => {
      setCode(
        await runWithSignals(
          (controller) =>
            runInboxRemove(
              { alias, ...(options.yes === true ? { yes: true } : {}) },
              createInboxDeps(controller.signal),
            ),
          SETUP_SIGNALS,
          SETUP_RERAISED,
        ),
      )
    })
}

/** The `pair` group: who answers, for CI (direct mode) and for the local service. */
function addPairCommands(program: Command, setCode: (code: number) => void): void {
  const pair = program
    .command('pair')
    .description('pair the owner or approvers for CI, or reset the owner of this machine')
  pair
    .command('ci')
    .description('pair an owner for CI and print the env vars for direct mode')
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    .action(async (options: { readonly provider?: string }) => {
      setCode(
        await runSetupCiCommand(
          options.provider === undefined ? {} : { provider: options.provider },
        ),
      )
    })
  pair
    .command('approver')
    .description('pair approvers for direct mode votes and print their ids')
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    .action(async (options: { readonly provider?: string }) => {
      setCode(
        await runPairApproverCommand(
          options.provider === undefined ? {} : { provider: options.provider },
        ),
      )
    })
  pair
    .command('reset-owner')
    .description('clear the paired owner so a new one can pair')
    .action(async () => {
      setCode(await runResetOwnerCommand())
    })
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

/** What the admin commands use, aimed at the `-s` remote; prompts abort with `signal`. */
function createAdminDeps(service: string | undefined, signal?: AbortSignal): AdminDeps {
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
    inboxPath: resolveInboxPath(process.env),
    service,
    isInteractive: process.stdin.isTTY === true,
    ...(signal === undefined ? {} : { signal }),
  }
}

/** Runs an admin command that may prompt, so Ctrl-C ends the prompt with exit 130. */
function runPromptingAdminCommand(
  service: string | undefined,
  run: (deps: AdminDeps) => Promise<number>,
): Promise<number> {
  return runWithSignals(
    (controller) => run(createAdminDeps(service, controller.signal)),
    SETUP_SIGNALS,
    SETUP_RERAISED,
  )
}

/** The `-s` remote of an `admin` subcommand, given before or after the subcommand. */
function findService(command: Command): string | undefined {
  return command.optsWithGlobals<{ readonly service?: string }>().service
}

/** The `admin bot` commands. */
function addAdminBotCommands(admin: Command, setCode: (code: number) => void): void {
  const bot = admin.command('bot').description("add, list and remove the service's bots")
  bot
    .command('add')
    .description('add a bot; asks for its settings')
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    .option('--label <text>', 'a name for the bot')
    .option('--json', JSON_HELP)
    .action(
      async (
        options: { readonly provider?: string; readonly label?: string; readonly json?: boolean },
        command: Command,
      ) => {
        setCode(
          await runPromptingAdminCommand(findService(command), (deps) => runBotAdd(options, deps)),
        )
      },
    )
  bot
    .command('list')
    .description('show the bots with their state, contacts and keys')
    .option('--json', JSON_HELP)
    .action(async (options: { readonly json?: boolean }, command: Command) => {
      setCode(await runBotList(options, createAdminDeps(findService(command))))
    })
  bot
    .command('remove')
    .description('remove a bot with its contacts and keys')
    .argument('<id>', 'bot id, such as b2')
    .option('-y, --yes', "don't ask first")
    .option('--json', JSON_HELP)
    .action(
      async (
        id: string,
        options: { readonly yes?: boolean; readonly json?: boolean },
        command: Command,
      ) => {
        setCode(
          await runPromptingAdminCommand(findService(command), (deps) =>
            runBotRemove({ id, ...options }, deps),
          ),
        )
      },
    )
  addAdminContactCommands(bot, setCode)
}

/** The `admin bot contact` commands. */
function addAdminContactCommands(bot: Command, setCode: (code: number) => void): void {
  const contact = bot
    .command('contact')
    .description('add, list and remove the people a bot can ask')
  contact
    .command('add')
    .description('add a contact with no key (an approver) and print its pairing code')
    .argument('<bot>', 'bot id, such as b1')
    .option('--json', JSON_HELP)
    .action(async (botId: string, options: { readonly json?: boolean }, command: Command) => {
      setCode(
        await runContactAdd({ bot: botId, ...options }, createAdminDeps(findService(command))),
      )
    })
  contact
    .command('list')
    .description('show the contacts with their keys and the codes of pending ones')
    .argument('[bot]', "only this bot's contacts, such as b1")
    .option('--json', JSON_HELP)
    .action(
      async (botId: string | undefined, options: { readonly json?: boolean }, command: Command) => {
        const args = botId === undefined ? options : { bot: botId, ...options }
        setCode(await runContactList(args, createAdminDeps(findService(command))))
      },
    )
  contact
    .command('remove')
    .description('remove a contact and revoke its keys')
    .argument('<contact>', 'contact id, such as c2')
    .option('-y, --yes', "don't ask first")
    .option('--json', JSON_HELP)
    .action(
      async (
        id: string,
        options: { readonly yes?: boolean; readonly json?: boolean },
        command: Command,
      ) => {
        setCode(
          await runPromptingAdminCommand(findService(command), (deps) =>
            runContactRemove({ id, ...options }, deps),
          ),
        )
      },
    )
}

/** The `admin key` commands. */
function addAdminKeyCommands(admin: Command, setCode: (code: number) => void): void {
  const key = admin.command('key').description('create and revoke API keys')
  key
    .command('create')
    .description('create an API key and print it once')
    .option('--bot <id>', 'for a new pairing on this bot, with a pairing code')
    .option('--pairing <id>', 'for this existing pairing')
    .option('--same-as <key id>', 'for the pairing of this key')
    .option('--label <text>', 'a free-form label')
    .option('--external-id <id>', 'a free-form id from another system')
    .option('--save', "also save the key to this machine's inbox")
    .option('--as <alias>', "with --save, the bot's alias (default: the bot's name)")
    .option('--invite', 'print a jaypost inbox join line to send instead of the key (remotes only)')
    .option('--json', JSON_HELP)
    .action(
      async (
        options: {
          readonly bot?: string
          readonly pairing?: string
          readonly sameAs?: string
          readonly label?: string
          readonly externalId?: string
          readonly save?: boolean
          readonly as?: string
          readonly invite?: boolean
          readonly json?: boolean
        },
        command: Command,
      ) => {
        setCode(
          await runPromptingAdminCommand(findService(command), (deps) =>
            runKeyCreate(options, deps),
          ),
        )
      },
    )
  key
    .command('revoke')
    .description('revoke a key; its pairing stays')
    .argument('<id>', 'key id, such as k2')
    .option('--json', JSON_HELP)
    .action(async (id: string, options: { readonly json?: boolean }, command: Command) => {
      setCode(await runKeyRevoke({ id, ...options }, createAdminDeps(findService(command))))
    })
}

/**
 * The `admin` group, which calls a service's admin routes: the remote `-s` names, else the env,
 * the local install or the only remote. Also the hidden top-level `admin-key show`.
 */
function addAdminCommands(program: Command, setCode: (code: number) => void): void {
  const admin = program
    .command('admin')
    .description("manage a service's bots, contacts and keys, and the remotes you administer")
    .option('-s, --service <name>', 'the remote to manage (default: the local service)')
  addAdminBotCommands(admin, setCode)
  addAdminKeyCommands(admin, setCode)
  addAdminRemoteCommands(admin, setCode)
  admin
    .command('rotate-key')
    .description('replace the admin key, print the new one and save it to your inbox')
    .option('--json', JSON_HELP)
    .action(async (options: { readonly json?: boolean }, command: Command) => {
      setCode(await runAdminKeyRotate(options, createAdminDeps(findService(command))))
    })
  admin
    .command('log')
    .description("show every bot's questions (the service's whole log)")
    .option(
      '--since <when>',
      'only newer questions: 12h, 7d, 2026-10-18 or an ISO date-time',
      parseSinceOption,
    )
    .option('--project <name>', 'only questions from this project', parseProjectOption)
    .option('-n, --limit <n>', 'show the last N (default 20, or all with --since)', parseLimit)
    .option('--bot <id>', "only this bot's questions")
    .option('--contact <id>', "only this contact's questions")
    .option('--key <id>', "only this key's questions")
    .option('--all', "every bot's questions (the default)")
    .option('--json', 'print one JSON entry per line')
    .action(async (options: AdminLogArgs, command: Command) => {
      setCode(
        await runAdminLog(options, {
          ...createAdminDeps(findService(command)),
          print: (text) => writeAll(`${text}\n`),
          version: VERSION,
        }),
      )
    })
  // Runs inside containers to print the admin key from the data volume.
  const adminKey = program.command('admin-key', { hidden: true })
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

/** Takes argv without node and script path; returns the exit code (2 for usage errors). */
export async function main(argv: readonly string[]): Promise<number> {
  let code = 0
  const program = new Command('jaypost').version(VERSION, '-v, --version').exitOverride()
  program.commandsGroup('Set up:')
  addServiceCommands(program, (serviceCode) => {
    code = serviceCode
  })
  addInboxCommands(program, (inboxCode) => {
    code = inboxCode
  })
  addPairCommands(program, (pairCode) => {
    code = pairCode
  })
  addAdminCommands(program, (adminCode) => {
    code = adminCode
  })
  program.commandsGroup('Ask and notify:')
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
    .option(BOT_FLAGS, BOT_DESCRIPTION)
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
          readonly bot?: string
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
            : await runSendRequestWithSignals(args, options.bot)
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
      '--delete-after <seconds|timestamp>',
      'delete the message after this many seconds or at this ISO 8601 time (default 8h; ignored in direct mode)',
    )
    .option(BOT_FLAGS, BOT_DESCRIPTION)
    .action(
      async (
        text: string,
        options: {
          readonly project?: string
          readonly format?: MessageFormat
          readonly attach?: string
          readonly attachName?: string
          readonly deleteAfter?: string
          readonly bot?: string
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
          ...(options.deleteAfter === undefined ? {} : { deleteAfter: options.deleteAfter }),
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
                  createSendDeps(options.bot, controller.signal, createStderrProgress()),
                ),
              )
      },
    )
  program
    .command('hook')
    .description(
      'answer Claude Code permission prompts, forward notifications and ask for the next prompt when Claude stops (reads a hook event on stdin)',
    )
    .option(BOT_FLAGS, BOT_DESCRIPTION)
    .option('--project <name>', 'shown as [name] (default: the Claude Code project folder)')
    .option(
      '--timeout <seconds>',
      'seconds to wait for an answer; default 300 (3600 for Stop), max 86400 (24 h); longer values are capped',
      parseTimeout,
    )
    .action(
      async (options: {
        readonly bot?: string
        readonly project?: string
        readonly timeout?: number
      }) => {
        const args = {
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        }
        code = await runWithSignals(
          (controller) => runHook(args, createHookDeps(options.bot, controller.signal)),
          ['SIGINT', 'SIGTERM'],
        )
      },
    )
  program
    .command('mcp')
    .description('run an MCP server on stdin/stdout for agents')
    .option(BOT_FLAGS, BOT_DESCRIPTION)
    .action(async (options: { readonly bot?: string }) => {
      const resolved = resolveBot(process.env, options.bot)
      code = await runMcp({
        version: VERSION,
        endpoint: resolved.endpoint,
        readToken: () => resolved.token,
      })
    })
  program.commandsGroup('Check:')
  program
    .command('status')
    .description('show the bot and its pairing state')
    .option(BOT_FLAGS, BOT_DESCRIPTION)
    .action(async (options: { readonly bot?: string }) => {
      code = await runStatusCommand(options.bot)
    })
  program
    .command('ping')
    .description('send a test message to check the service and pairing')
    .option(BOT_FLAGS, BOT_DESCRIPTION)
    .action(async (options: { readonly bot?: string }) => {
      const resolved = resolveBot(process.env, options.bot)
      const progress = createStderrProgress()
      const runLive = (controller: AbortController) =>
        runPing({
          endpoint: resolved.endpoint,
          token: resolved.token,
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
    .option(BOT_FLAGS, BOT_DESCRIPTION)
    .action(
      async (options: {
        readonly since?: Date
        readonly project?: string
        readonly limit?: number
        readonly json?: boolean
        readonly bot?: string
      }) => {
        code = await runLogCommand(
          {
            ...(options.since === undefined ? {} : { since: options.since }),
            ...(options.project === undefined ? {} : { project: options.project }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.json === undefined ? {} : { json: options.json }),
          },
          options.bot,
        )
      },
    )
  // For developers; docs/http-api.md points to it.
  program
    .command('openapi', { hidden: true })
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
    await program.parseAsync(argv.length === 0 ? ['--help'] : argv, {
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
  // `service run` keeps the process alive via the server and bot; only exit for other commands.
  if (!(process.argv[2] === 'service' && process.argv[3] === 'run')) {
    process.exit(code)
  }
}
