import type { Inbox, ClientToken, Exec } from '@jaypost/store'
import type { AdminCaller, AttachmentSource, ResolvedBot, ServiceEndpoint } from '@jaypost/client'
import type {
  MessageFormat,
  Provider,
  ProviderRuntime,
  SettingValues,
  VoteRule,
} from '@jaypost/core'
import type { CliLocation, InstallPaths, InstallRecord, Target, TargetName } from '@jaypost/install'
import type { Progress } from '../progress/index.ts'
import type { StatusInfo } from '@jaypost/protocol'

/** One entry in a select prompt; a `disabled` reason shows it as unavailable. */
export type SelectOption<T extends string> = {
  readonly value: T
  readonly label: string
  readonly disabled?: string
}

/** The prompts the commands use; injectable so tests can fake them. */
export type Prompts = {
  readonly confirm: (message: string, initialValue: boolean) => Promise<boolean>
  readonly password: (message: string) => Promise<string>
  readonly text: (message: string) => Promise<string>
  readonly select: <T extends string>(
    message: string,
    options: readonly SelectOption<T>[],
    initialValue: T,
  ) => Promise<T>
}

/** What the inbox commands touch outside themselves, injected for tests. */
export type InboxDeps = {
  readonly inboxPath: string
  readonly prompt: Prompts
  /** True on a terminal; only then may a command ask before overwriting. */
  readonly isInteractive: boolean
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
}

/** Inputs to `resolveProviderSettings`. */
export type ProviderSettingsOptions = {
  readonly provider: Provider
  /** Settings saved earlier for this provider; {} when there are none. */
  readonly saved: SettingValues
  readonly prompt: Prompts
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
  /** Every secret value typed in is pushed here, so callers can mask it in errors. */
  readonly seen: string[]
}

/** The settings to use, or rejected: nothing to ask for and the saved ones failed the check. */
export type ProviderSettingsResult =
  | {
      readonly kind: 'accepted'
      readonly settings: SettingValues
      /** Account the credential check named; absent when the provider has no settings to check. */
      readonly displayName?: string
    }
  | { readonly kind: 'rejected' }

/** Result of one /status call: a parsed answer, a 401, or no usable answer. */
export type StatusFetch =
  | { readonly kind: 'answered'; readonly status: StatusInfo }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreachable' }

/** Signature of `defaultFetchStatus`, injectable for tests. */
export type FetchStatus = (url: URL, token: string | undefined) => Promise<StatusFetch>

/** Inputs to `waitForPairing`; the optional fields are test seams with real defaults. */
export type WaitOptions = {
  /** The service's base URL; `toLocalEndpoint(port).url` for the one on this machine. */
  readonly url: URL
  readonly isRunning: () => Promise<boolean>
  /** Appended to the message when the service stops while waiting. */
  readonly logsHint: string
  readonly signal?: AbortSignal
  /** Injectable for tests; defaults to `defaultFetchStatus`. */
  readonly fetchStatus?: FetchStatus
  /** Sent as a bearer token on every /status poll. */
  readonly token?: string
  readonly sleep?: (delayMs: number) => Promise<void>
  /** Limit on waiting for the first /status answer; defaults to `DEFAULT_START_TIMEOUT_MS`. */
  readonly startTimeoutMs?: number
  /** Shows the service start and the pairing code as steps. */
  readonly progress: Progress
}

/**
 * Why `waitForPairing` returned: paired, Ctrl-C, no answer within the start timeout, the service
 * stopped, or the service rejected the token.
 */
export type WaitResult = 'paired' | 'interrupted' | 'notStarted' | 'stopped' | 'unauthorized'

/** Signature of `waitForPairing`, injectable for tests. */
export type WaitForPairing = (options: WaitOptions) => Promise<WaitResult>

/** Everything `runInit` touches outside itself, injected for tests. */
export type InitDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly prompt: Prompts
  /** Registered providers; init asks which one to use when there are several. */
  readonly providers: readonly Provider[]
  readonly isPortFree: (port: number) => Promise<boolean>
  readonly wait: WaitForPairing
  /** Checklist for the checks and install; human text goes through `progress.note`. */
  readonly progress: Progress
  readonly signal?: AbortSignal
  readonly version: string
  /** Defaults to process.env; used to find the systemd config file. */
  readonly env?: NodeJS.ProcessEnv
  /** Defaults to process.platform; picks the target order. */
  readonly platform?: string
  /** IANA zone passed to container installs as `TZ`; omitted when unknown. */
  readonly timeZone?: string
  /** The inbox; gets the local service and its seed bot. */
  readonly inboxPath: string
  /** This machine's name (`os.hostname()`), for the `remote add` line `--exposed` prints. */
  readonly hostname: string
}

/** Parsed `service install` flags; absent fields mean the user didn't pass them. */
export type InitArgs = {
  readonly target?: TargetName
  readonly port?: number
  /** Listen on all interfaces over plain http instead of loopback. */
  readonly exposed?: boolean
  readonly tarball?: string
  readonly provider?: string
  /** `true` for `--token`, `false` for `--no-token`; absent when neither was passed. */
  readonly token?: boolean
}

/** Everything `runResetOwner` touches outside itself, injected for tests. */
export type ResetOwnerDeps = {
  /** Read for `JAYPOST_URL`, which reset-owner refuses, and `JAYPOST_ADMIN_KEY`. */
  readonly env: NodeJS.ProcessEnv
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly providers: readonly Provider[]
  readonly confirm: Prompts['confirm']
  readonly wait: WaitForPairing
  readonly progress: Progress
  readonly signal?: AbortSignal
  /** The inbox; the local seed bot's key is key 1's token, whose /status names the contact. */
  readonly inboxPath: string
  readonly fetchStatus: FetchStatus
  /** Delay between /status polls while the service starts; defaults to an abortable timer. */
  readonly sleep?: (delayMs: number) => Promise<void>
}

/** Everything `runStatus` touches outside itself, injected for tests. */
export type StatusDeps = {
  /** The bot `status` asks about; its key is sent to /status but never printed. */
  readonly resolved: ResolvedBot
  /** The install on this machine, if any; only shown when the bot is on this machine. */
  readonly install: { readonly record: InstallRecord; readonly target: Target } | undefined
  readonly fetchStatus: FetchStatus
  readonly print: (text: string) => void
}

/** Parsed `log` flags; absent fields mean the user didn't pass them. */
export type LogArgs = {
  readonly since?: Date
  readonly project?: string
  readonly limit?: number
  readonly json?: boolean
}

/** Everything `runLog` touches outside itself, injected for tests. */
export type LogDeps = {
  /** The bot whose GET /log is read. */
  readonly endpoint: ServiceEndpoint
  readonly token: ClientToken
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
}

/** Everything `runUninstall` touches outside itself, injected for tests. */
export type UninstallDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly confirm: Prompts['confirm']
  readonly progress: Progress
  readonly signal?: AbortSignal
  /** The inbox; loses the local service and its bots. */
  readonly inboxPath: string
}

/** Everything `runServiceStart` and `runServiceStop` touch outside themselves, injected for tests. */
export type ServiceControlDeps = {
  readonly paths: InstallPaths
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
}

/** Everything `runUpdate` and `runFinishUpdate` touch outside themselves, injected for tests. */
export type UpdateDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly providers: readonly Provider[]
  readonly exec: Exec
  /** The CLI running `service update`; it updates itself for container installs or no install. */
  readonly cli: CliLocation
  /** This CLI's version; the finish step installs it. */
  readonly version: string
  /** Node's `process.platform`, for picking the release asset. */
  readonly platform: string
  /** Node's `process.arch`, for picking the release asset. */
  readonly arch: string
  readonly releasesUrl: string
  readonly npmLatestUrl: string
  /** Steps draw on it; the former printed lines are its notes. */
  readonly progress: Progress
  readonly signal?: AbortSignal
  /** Defaults to process.env; used to find the systemd config file. */
  readonly env?: NodeJS.ProcessEnv
  /** IANA zone passed to container installs as `TZ`; omitted when unknown. */
  readonly timeZone?: string
}

/** `request` input; `timeout` in seconds, capped to 86400 (24 h) by the service. */
export type SendRequestArgs = {
  readonly text: string
  /** Button labels; required unless `allowText`. */
  readonly options?: readonly string[]
  /** Let the owner answer with a text reply. */
  readonly allowText?: boolean
  readonly timeoutOption: string
  readonly timeout?: number
  readonly project?: string
  readonly format?: MessageFormat
  /** Print `{ answer, timedOut }` instead of the bare answer. */
  readonly json?: boolean
  /** A file to send with the question. */
  readonly attachment?: AttachmentSource
  /** User ids who vote; setting this or `rule` makes the question a vote. */
  readonly voters?: readonly string[]
  /** How the votes decide; defaults to `all`. */
  readonly rule?: VoteRule
  /** Re-ask after a timeout up to this many times. */
  readonly retryCount?: number
}

/** `notify` input. */
export type SendNotifyArgs = {
  readonly text: string
  readonly project?: string
  readonly format?: MessageFormat
  /** A file to send with the message. */
  readonly attachment?: AttachmentSource
  /** Seconds or an ISO 8601 timestamp, as typed; the service decides which and validates it. */
  readonly deleteAfter?: string
}

/** Where `send` talks to and writes; aborting `signal` cancels the call. */
export type SendDeps = {
  readonly endpoint: ServiceEndpoint
  readonly token: ClientToken
  readonly signal: AbortSignal
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
  /** Live mode waits for the answer in the background and shows the countdown on stderr. */
  readonly progress: Progress
  /** Names the provider in the "Sent to ..." line. */
  readonly providers: readonly Provider[]
  /** Monotonic clock in ms; defaults to `performance.now`. Tests pin it. */
  readonly now?: () => number
  /** Wall clock in ms, read once to place the service's expiry; defaults to `Date.now`. */
  readonly wallNow?: () => number
}

/** Everything `runPing` touches outside itself, injected for tests. */
export type PingDeps = {
  readonly endpoint: ServiceEndpoint
  readonly token: ClientToken
  readonly progress: Progress
  readonly providers: readonly Provider[]
  readonly signal: AbortSignal
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
}

/** What direct `send` reads and writes; aborting `signal` cancels a pending question. */
export type DirectSendDeps = {
  readonly env: NodeJS.ProcessEnv
  readonly providers: readonly Provider[]
  readonly signal: AbortSignal
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
  /** Confirms a sent notification on stderr in a terminal; silent otherwise. */
  readonly progress: Progress
  /** Monotonic clock in ms; defaults to `performance.now`. Tests pin it. */
  readonly now?: () => number
}

/** Parsed `setup-ci` flags; absent fields mean the user didn't pass them. */
export type SetupCiArgs = {
  readonly provider?: string
}

/** Everything `runSetupCi` touches outside itself; no paths or targets, so it writes no files. */
export type SetupCiDeps = {
  readonly prompt: Prompts
  /** Registered providers; setup-ci asks which one to use when there are several. */
  readonly providers: readonly Provider[]
  /** Stdout: only the env var block and the approver ids, which scripts read. */
  readonly print: (text: string) => void
  /** Stderr checklist and notes (everything else setup-ci says). */
  readonly progress: Progress
  readonly signal?: AbortSignal
  /** The runtime's log; defaults to stderr. */
  readonly log?: (line: string) => void
  /** Defaults to a random pairing code. */
  readonly generateCode?: () => string
}

/** Parsed `pair approver` flags; absent fields mean the user didn't pass them. */
export type PairApproverArgs = {
  readonly provider?: string
}

/** Everything `runPairApprover` touches outside itself; the same needs as `setup-ci`. */
export type PairApproverDeps = SetupCiDeps

/** How `setup-ci`'s wait for one pairing code (owner or approver) ended. */
export type OwnerPairing =
  | { readonly kind: 'paired'; readonly senderId: string }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'fatal'; readonly message: string }
  | { readonly kind: 'interrupted' }

/**
 * Shows a fresh pairing code with `instructions(code)` as a step titled `titles.waiting` and waits
 * for how that pairing ends; a pairing ends the step as `titles.paired`.
 */
export type PairingWaiter = (
  instructions: (code: string) => string,
  titles: { readonly waiting: string; readonly paired: string },
) => Promise<OwnerPairing>

/** A provider with checked credentials and a runtime the caller must stop, or failed (already reported). */
export type OpenedRuntime =
  | {
      readonly kind: 'opened'
      readonly provider: Provider
      readonly settings: SettingValues
      readonly runtime: ProviderRuntime
    }
  | { readonly kind: 'failed' }

/** The admin key for the service, or why there is none (already worded for the user). */
export type AdminKeyLookup =
  | { readonly kind: 'found'; readonly adminKey: string }
  | { readonly kind: 'missing'; readonly message: string }

/**
 * Where the admin commands send their calls: a remote from the inbox or `JAYPOST_URL` (its key from
 * `JAYPOST_ADMIN_KEY`), or the service on this machine (an install, or none with the config's
 * port), or why none works.
 */
export type AdminEndpoint =
  | {
      readonly kind: 'remote'
      /** The inbox's name for the remote; undefined for `JAYPOST_URL`. */
      readonly name: string | undefined
      readonly endpoint: ServiceEndpoint
      readonly adminKey: AdminKeyLookup
    }
  | {
      readonly kind: 'local'
      readonly endpoint: ServiceEndpoint
      readonly port: number
      readonly adminKey: AdminKeyLookup
      /** Undefined when nothing is installed and the service runs some other way. */
      readonly install: InstallRecord | undefined
      /** The config file the service reads; undefined for a container install. */
      readonly configPath: string | undefined
    }
  | { readonly kind: 'failed'; readonly message: string }

/** The local variant of `AdminEndpoint`. */
export type LocalAdminEndpoint = Extract<AdminEndpoint, { readonly kind: 'local' }>

/** An endpoint the admin commands can call. */
export type ReachableEndpoint = Exclude<AdminEndpoint, { readonly kind: 'failed' }>

/**
 * A caller with its endpoint; `noKey` is a service whose admin key can't be found (the message
 * says why); `failed` is no usable endpoint.
 */
export type OpenedAdmin =
  | {
      readonly kind: 'opened'
      readonly caller: AdminCaller
      readonly endpoint: ReachableEndpoint
    }
  | {
      readonly kind: 'noKey'
      readonly endpoint: ReachableEndpoint
      readonly message: string
    }
  | { readonly kind: 'failed'; readonly message: string }

/** The inbox, or why it can't be read (the message names the file, never a value). */
export type LoadedInbox =
  | { readonly kind: 'loaded'; readonly inbox: Inbox }
  | { readonly kind: 'failed'; readonly message: string }

/** Everything the admin commands touch outside themselves, injected for tests. */
export type AdminDeps = {
  readonly env: NodeJS.ProcessEnv
  readonly paths: InstallPaths
  readonly targets: Readonly<Record<TargetName, Target>>
  /** Registered providers; `bot add` asks which one to use when there are several. */
  readonly providers: readonly Provider[]
  readonly prompt: Prompts
  /** Stdout: tables, JSON and the one-time key lines. */
  readonly print: (text: string) => void
  /** Stderr: failures, prompts' notes and hints. */
  readonly printError: (text: string) => void
  /** Tells whether a local service without a readable admin key is up. */
  readonly fetchStatus: FetchStatus
  /** Defaults to the current time; stamps a bot `bot add` writes straight to the registry. */
  readonly now?: () => Date
  readonly signal?: AbortSignal
  /** The inbox: remotes, the local admin key, and where `key create --save` writes. */
  readonly inboxPath: string
  /** The remote `-s` names; undefined picks the target as `openAdmin` describes. */
  readonly service: string | undefined
  /** True on a terminal; only then may a command ask before replacing an inbox entry. */
  readonly isInteractive: boolean
}

/** What `admin log` needs on top of `AdminDeps`. */
export type AdminLogDeps = AdminDeps & {
  /** This CLI's version; an install recorded with it is read whatever its number. */
  readonly version: string
}

/** Every admin command takes `--json`. */
export type AdminOutputArgs = { readonly json?: boolean }

export type BotAddArgs = AdminOutputArgs & {
  readonly provider?: string
  readonly label?: string
}

/** `bot remove` and `contact remove`; `yes` skips the confirmation. */
export type AdminRemoveArgs = AdminOutputArgs & { readonly id: string; readonly yes?: boolean }

/**
 * Exactly one of `bot`, `pairing` and `sameAs` names the pairing the key points to. At most one of
 * `save` and `invite`; `as` only with `save`.
 */
export type KeyCreateArgs = AdminOutputArgs & {
  readonly bot?: string
  readonly pairing?: string
  readonly sameAs?: string
  readonly label?: string
  readonly externalId?: string
  /** Also save the key to this machine's inbox as a bot. */
  readonly save?: boolean
  /** The alias `save` uses instead of the bot's label, display name or id. */
  readonly as?: string
  /** Print a `jaypost inbox join` line for the person instead of the bare key; remotes only. */
  readonly invite?: boolean
}

export type AdminIdArgs = AdminOutputArgs & { readonly id: string }

export type ContactAddArgs = AdminOutputArgs & { readonly bot: string }

export type ContactListArgs = AdminOutputArgs & { readonly bot?: string }

/** Parsed `admin log` flags; no `bot`, `contact` or `key` means every bot's questions. */
export type AdminLogArgs = LogArgs & {
  readonly bot?: string
  readonly contact?: string
  readonly key?: string
  /** Every bot's questions; the same as giving no filter flag. */
  readonly all?: boolean
}
