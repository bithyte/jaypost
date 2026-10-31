import type { TargetName } from '@jaypost/install'
import type { AdminKeySource, OwnerPairing, StatusFetch } from './types.ts'

/** Display names for the install target prompt. */
export const TARGET_LABELS: Readonly<Record<TargetName, string>> = {
  quadlet: 'Podman Quadlet (user service)',
  compose: 'Docker Compose',
  systemd: 'systemd user service (npm)',
  launchd: 'launchd user agent (macOS)',
}
/** How long to wait for the service to answer /status for the first time. */
export const DEFAULT_START_TIMEOUT_MS = 60_000
/** Delay between /status polls while waiting for pairing. */
export const POLL_INTERVAL_MS = 1000
/** How many /status polls fit in the start timeout. */
export const START_POLL_COUNT = DEFAULT_START_TIMEOUT_MS / POLL_INTERVAL_MS
/** Per-request timeout for one /status call. */
export const STATUS_TIMEOUT_MS = 2000

/** The service answered /status with 401. */
export const UNAUTHORIZED_STATUS = { kind: 'unauthorized' } as const satisfies StatusFetch
/** No usable /status answer: not up yet, a network error or an unexpected body. */
export const UNREACHABLE_STATUS = { kind: 'unreachable' } as const satisfies StatusFetch

/**
 * `request` exit code in direct mode when the answer is the `-d` value or the timeout fired,
 * and in both modes when a vote rejects.
 */
export const DECLINED_EXIT_CODE = 3
/** Shown for a failed provider send; the cause can hold provider internals, so it's left out. */
export const DIRECT_SEND_FAILED_MESSAGE = 'failed to send message'
/** Shown when a direct question is cancelled by a signal. */
export const DIRECT_CANCELLED_MESSAGE = 'cancelled'

/** Someone sent too many wrong pairing codes while `setup-ci` waited. */
export const BLOCKED_PAIRING = { kind: 'blocked' } as const satisfies OwnerPairing
/** `setup-ci` was interrupted while waiting for the owner. */
export const INTERRUPTED_PAIRING = { kind: 'interrupted' } as const satisfies OwnerPairing
/** Printed above the env lines `setup-ci` ends with. */
export const SETUP_CI_SECRETS_HINT =
  "Add these as GitHub secrets and pass them to jaypost through the step's `env:`, never on the command line:"
/** Printed after the env lines `setup-ci` ends with. */
export const SETUP_CI_APPROVERS_HINT = 'To add approvers, run: jaypost pair approver'
/** Printed above the comma list of ids `pair approver` ends with. */
export const PAIRED_APPROVERS_HEADING =
  'Add these to your approvers list and the JAYPOST_APPROVERS secret (each also works as -u ID):'
/** Printed with every new API key: the service keeps only its hash. */
export const KEY_SHOWN_ONCE_NOTE = "This key isn't shown again; store it now."
/** `bot add` without an admin key, when the service it meant to write behind came up meanwhile. */
export const STARTED_MEANWHILE_MESSAGE =
  'The service started while the settings were asked, so nothing was written. Run jaypost admin bot add again.'

/** The base URL of the service on this machine at `port`. */
export function toLocalUrl(port: number): URL {
  return new URL(`http://127.0.0.1:${port}/`)
}

/** The admin key came from `JAYPOST_ADMIN_KEY`. */
export const ENV_KEY_SOURCE = { kind: 'env' } as const satisfies AdminKeySource

/** The admin key came from the install: its copy in the inbox, or its target. */
export const INSTALL_KEY_SOURCE = { kind: 'install' } as const satisfies AdminKeySource

/** The admin key came from the admin key file next to the config. */
export const FILE_KEY_SOURCE = { kind: 'keyFile' } as const satisfies AdminKeySource
