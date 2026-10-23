import type { z } from 'zod'
import type { ApiAuth } from '../auth/index.ts'
import type { Provider, SettingValues } from '../provider/index.ts'
import type { Exec } from '../system/index.ts'
import type { installRecordSchema } from './schema.ts'

/** What install.json stores: which target is installed, its port and version. */
export type InstallRecord = Readonly<z.infer<typeof installRecordSchema>>
/** Install target id, one of systemd, compose, quadlet or launchd. */
export type TargetName = InstallRecord['target']

/** Absolute locations for each target's files. */
export type InstallPaths = {
  readonly configDirectory: string
  readonly configFile: string
  readonly installFile: string
  /** The client token file `init` writes for the CLI and MCP server. */
  readonly tokenFile: string
  readonly composeDirectory: string
  readonly quadletDirectory: string
  readonly systemdUnit: string
  readonly quadletUnit: string
  /** Fallback npm prefix for installing the CLI when the global one isn't writable. */
  readonly userNpmPrefix: string
  /** Where a systemd or launchd install copies the standalone binary; always ~/.local/bin. */
  readonly binaryCopy: string
  /** The launchd agent's plist in ~/Library/LaunchAgents. */
  readonly launchdPlist: string
  /** Where the launchd agent's stdout and stderr go; launchd has no journal. */
  readonly launchdLogFile: string
}

/** Provider name and its settings found in an existing install; absent settings weren't found. */
export type Secrets = {
  readonly provider: string
  readonly settings: SettingValues
}

/**
 * What a target needs to install; `tarball` installs an unpublished build, and `print` reports
 * progress.
 */
export type InstallOptions = {
  readonly version: string
  readonly port: number
  readonly provider: Provider
  /** The current provider's settings; the owner setting is left alone when absent. */
  readonly settings: SettingValues
  /** The token the service enforces; `none` leaves the service without one. */
  readonly auth: ApiAuth
  /** IANA zone written as `TZ` into container env files; systemd ignores it. */
  readonly timeZone?: string
  readonly tarball?: string
  readonly print: (text: string) => void
  /** Receives the build and npm install output as it arrives; when unset, builds inherit stdio. */
  readonly output?: (chunk: string) => void
}

/** Whether a target can be used here; `reason` says why not. */
export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Lifecycle operations for one install method; failures throw. */
export type Target = {
  readonly name: TargetName
  readonly available: () => Promise<Availability>
  /** Writes files, builds if needed, starts. */
  readonly install: (options: InstallOptions) => Promise<InstallRecord>
  /**
   * Rewrites the files from the current templates at `options.version`, switches the running
   * service over and returns the new record. Never calls `remove`; a failed build throws and
   * leaves the old service running.
   */
  readonly upgrade: (options: InstallOptions, previous: InstallRecord) => Promise<InstallRecord>
  readonly readSecrets: (record: InstallRecord) => Promise<Secrets>
  /**
   * Stop and delete files; purge also deletes credential and owner storage. Hints for the user go
   * to `print` (stdout when not given).
   */
  readonly remove: (
    record: InstallRecord,
    purge: boolean,
    print?: (text: string) => void,
  ) => Promise<void>
  readonly restart: (record: InstallRecord) => Promise<void>
  readonly clearOwner: (record: InstallRecord) => Promise<void>
  readonly isRunning: (record: InstallRecord) => Promise<boolean>
  /** Raw contents of audit.jsonl.1 then audit.jsonl; '' when neither exists. Throws when it can't read. */
  readonly readAuditLog: (record: InstallRecord) => Promise<string>
  readonly logsHint: (record: InstallRecord) => string
}

/** External dependencies of the targets, injected for tests. */
export type TargetDeps = {
  readonly exec: Exec
  readonly paths: InstallPaths
  readonly env: NodeJS.ProcessEnv
  readonly user: string
  /** Registered providers, for reading secrets back and clearing the owner. */
  readonly providers: readonly Provider[]
  /** Node's `process.platform`; launchd is only available on `darwin`. */
  readonly platform: string
  /** The user's uid, for the launchd `gui/<uid>` domain. */
  readonly uid: number
}

/**
 * What the systemd unit execs: the running npm CLI script with its node binary, or the running
 * standalone binary.
 */
export type CliLocation =
  | { readonly kind: 'npm'; readonly selfPath: string; readonly nodePath: string }
  | { readonly kind: 'binary'; readonly binaryPath: string }

/** What the service execs before `start`: the CLI path and the full command words. */
export type CliCommand = { readonly cliPath: string; readonly words: readonly string[] }

/** A target name with its availability. */
export type DetectedTarget = { readonly name: TargetName } & Availability

/**
 * An install found on disk; `legacy` means it was rebuilt from an old systemd unit, with no
 * install.json.
 */
export type ExistingInstall = {
  readonly record: InstallRecord
  readonly legacy: boolean
}
