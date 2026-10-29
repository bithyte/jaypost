import type { TargetName } from './types.ts'

/** Preference order; the first available target is the default. */
export const TARGET_ORDER: readonly TargetName[] = ['quadlet', 'compose', 'systemd']
/** Preference order on macOS, where launchd leads and is the only native service manager. */
export const DARWIN_TARGET_ORDER: readonly TargetName[] = [
  'launchd',
  'quadlet',
  'compose',
  'systemd',
]
/** Host an exposed install binds, on all interfaces over plain http. */
export const EXPOSED_HOST = '0.0.0.0'
/** Name of the systemd unit and container. */
export const SERVICE_NAME = 'jaypost'
/** npm package name, also the container's command. */
export const PACKAGE_NAME = 'jaypost'
/** Podman volume holding /data (the config file). */
export const VOLUME_NAME = 'jaypost-data'
/** Keeps the .env file with the credentials out of the image build context. */
export const DOCKERIGNORE = '.env\n'
/** Quadlet needs podman 4.4 or newer (major part). */
export const MIN_PODMAN_MAJOR = 4
/** Quadlet needs podman 4.4 or newer (minor part). */
export const MIN_PODMAN_MINOR = 4
/** A carriage return or newline, which an env file value must not contain. */
export const LINE_BREAK_PATTERN = /[\r\n]/
/** podman stderr meaning the thing is already gone, which purge treats as success. */
export const NOT_FOUND_PATTERN = /no such|not found|does not exist/i
/** Captures major, minor and optional patch from `podman --version`. */
export const PODMAN_VERSION_PATTERN = /(\d+)\.(\d+)(?:\.(\d+))?/
/** Matches an `Environment=` line in a unit file. */
export const ENVIRONMENT_LINE_PATTERN = /^\s*Environment=(.*)$/
/** Matches an `ExecStart=` line in a unit file. */
export const EXEC_START_LINE_PATTERN = /^\s*ExecStart=(.*)$/
/** Matches a backslash escape inside a quoted unit value. */
export const ESCAPED_CHAR_PATTERN = /\\(.)/g
/** Variable the unit sets to pin the config file path. */
export const CONFIG_ENV_PREFIX = 'JAYPOST_CONFIG='
/** Owner read/write only, for files that hold credentials. */
export const SECRET_FILE_MODE = 0o600
/** Mode for the binary copy systemd runs. */
export const EXECUTABLE_MODE = 0o755
/** Printed when a binary install's ~/.local/bin isn't on PATH. */
export const PATH_HINT = "~/.local/bin isn't on your PATH; add it to run jaypost from anywhere."
/** The launchd agent's label, reverse-DNS as launchd labels conventionally are. */
export const LAUNCHD_LABEL = 'io.github.bithyte.jaypost'
/** `launchctl bootout` stderr meaning the agent wasn't loaded, which is fine. */
export const LAUNCHD_NOT_LOADED_PATTERN = /no such process|could not find/i
/** The service's own top-level `pid = N` line in `launchctl print` output. */
export const LAUNCHD_PID_PATTERN = /^\tpid = \d+$/m
/** Set by browsers on downloads; Gatekeeper may refuse an ad-hoc signed binary carrying it. */
export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'
