import type { ClientToken } from '../auth/index.ts'
import type { AttachmentSource, ServiceEndpoint } from '../client/index.ts'
import type { VoteRule } from '../approval/index.ts'
import type { MessageFormat } from '../format/index.ts'
import type { CliLocation, InstallPaths, Target, TargetName } from '../install/index.ts'
import type { Provider, SettingValues } from '../provider/index.ts'
import type { StatusInfo } from '../server/index.ts'
import type { Exec } from '../system/index.ts'

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
  | { readonly kind: 'accepted'; readonly settings: SettingValues }
  | { readonly kind: 'rejected' }

/** Result of one /status call: a parsed answer, a 401, or no usable answer. */
export type StatusFetch =
  | { readonly kind: 'answered'; readonly status: StatusInfo }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreachable' }

/** Signature of `defaultFetchStatus`, injectable for tests. */
export type FetchStatus = (port: number, token: string | undefined) => Promise<StatusFetch>

/** Inputs to `waitForPairing`; the optional fields are test seams with real defaults. */
export type WaitOptions = {
  readonly port: number
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
  readonly print?: (text: string) => void
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
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
  readonly version: string
  /** Defaults to process.env; used to find the systemd config file. */
  readonly env?: NodeJS.ProcessEnv
  /** Defaults to process.platform; picks the target order. */
  readonly platform?: string
  /** IANA zone passed to container installs as `TZ`; omitted when unknown. */
  readonly timeZone?: string
}

/** Parsed `init` flags; absent fields mean the user didn't pass them. */
export type InitArgs = {
  readonly target?: TargetName
  readonly port?: number
  readonly tarball?: string
  readonly provider?: string
  /** `true` for `--token`, `false` for `--no-token`; absent when neither was passed. */
  readonly token?: boolean
}

/** Everything `runResetOwner` touches outside itself, injected for tests. */
export type ResetOwnerDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly providers: readonly Provider[]
  readonly confirm: Prompts['confirm']
  readonly wait: WaitForPairing
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
  readonly token: ClientToken
}

/** Everything `runStatus` touches outside itself, injected for tests. */
export type StatusDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly fetchStatus: FetchStatus
  readonly token: ClientToken
  /** Token file path, named in the `Token:` line when the token came from it. */
  readonly tokenFile: string
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
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly env: NodeJS.ProcessEnv
  /** The running CLI's version, for the development exemption on the too-old check. */
  readonly version: string
  readonly now: () => Date
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
}

/** Everything `runUninstall` touches outside itself, injected for tests. */
export type UninstallDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly confirm: Prompts['confirm']
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
}

/** Everything `runUpdate` and `runFinishUpdate` touch outside themselves, injected for tests. */
export type UpdateDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly providers: readonly Provider[]
  readonly exec: Exec
  /** The CLI running `update`; it updates itself for container installs or no install. */
  readonly cli: CliLocation
  /** This CLI's version; the finish step installs it. */
  readonly version: string
  /** Node's `process.platform`, for picking the release asset. */
  readonly platform: string
  /** Node's `process.arch`, for picking the release asset. */
  readonly arch: string
  readonly releasesUrl: string
  readonly npmLatestUrl: string
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
  /** Defaults to process.env; used to find the systemd config file. */
  readonly env?: NodeJS.ProcessEnv
  /** IANA zone passed to container installs as `TZ`; omitted when unknown. */
  readonly timeZone?: string
}

/** `send request` input; `timeout` in seconds, capped to 86400 (24 h) by the service. */
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

/** `send notify` input. */
export type SendNotifyArgs = {
  readonly text: string
  readonly project?: string
  readonly format?: MessageFormat
  /** A file to send with the message. */
  readonly attachment?: AttachmentSource
}

/** Where `send` talks to and writes; aborting `signal` cancels the call. */
export type SendDeps = {
  readonly endpoint: ServiceEndpoint
  readonly token: ClientToken
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
}

/** Parsed `setup-ci` flags; absent fields mean the user didn't pass them. */
export type SetupCiArgs = {
  readonly provider?: string
  /** Skip pairing the owner and the env block; only pair approvers. */
  readonly approversOnly?: boolean
}

/** Everything `runSetupCi` touches outside itself; no paths or targets, so it writes no files. */
export type SetupCiDeps = {
  readonly prompt: Prompts
  /** Registered providers; setup-ci asks which one to use when there are several. */
  readonly providers: readonly Provider[]
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
  /** The runtime's log; defaults to stderr. */
  readonly log?: (line: string) => void
  /** Defaults to a random pairing code. */
  readonly generateCode?: () => string
}

/** How `setup-ci`'s wait for one pairing code (owner or approver) ended. */
export type OwnerPairing =
  | { readonly kind: 'paired'; readonly senderId: string }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'fatal'; readonly message: string }
  | { readonly kind: 'interrupted' }
