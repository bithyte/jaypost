import { basename } from 'node:path'
import { TOKEN_ENV_VAR } from '@jaypost/store'
import type { ApiAuth } from '@jaypost/store'
import type { Provider, SettingValues } from '@jaypost/core'
import { EXPOSED_HOST, LINE_BREAK_PATTERN } from './constants.ts'

/** Wraps in double quotes, escaping backslash and `"`, and doubling `%` (systemd specifier). */
export function quoteSystemdValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

/** Quotes one ExecStart word; `$` is also escaped there because systemd expands `$VAR` in ExecStart. */
export function quoteExecWord(word: string): string {
  return quoteSystemdValue(word).replaceAll('$', () => '$$')
}

/**
 * Image that installs the package from npm, or from a local tarball when given, and runs `service run` as
 * the node user.
 */
export function formatDockerfile(options: {
  readonly version: string
  readonly tarball?: string
}): string {
  const install =
    options.tarball === undefined
      ? `RUN npm i -g jaypost@${options.version}`
      : `COPY ${basename(options.tarball)} /tmp/pkg.tgz\nRUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz`
  return `FROM node:24-slim
ENV NODE_ENV=production JAYPOST_CONFIG=/data/config.json JAYPOST_HOST=0.0.0.0
${install}
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
CMD ["jaypost","service","run"]
`
}

/**
 * Compose file publishing `port` on loopback only, or on all interfaces when `exposed`, with a
 * named volume for /data.
 */
export function formatComposeYaml(port: number, exposed: boolean): string {
  return `name: jaypost
services:
  bot:
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - "${exposed ? '' : '127.0.0.1:'}${port}:${port}"
    volumes:
      - data:/data
volumes:
  data: {}
`
}

/**
 * KEY=VALUE lines for the container: `JAYPOST_PROVIDER`, then each known setting in declaration order with
 * `JAYPOST_PORT` after the first, and the api token (when set) right after `JAYPOST_PORT`. Throws a RangeError for
 * a value with a line break, which would inject lines. `TZ` is the last line when a time zone is
 * given.
 */
export function formatEnvFile(options: {
  readonly provider: Provider
  readonly port: number
  readonly settings: SettingValues
  readonly auth: ApiAuth
  readonly timeZone?: string
}): string {
  const settingLines = options.provider.settings.flatMap((setting) => {
    const value = options.settings[setting.configKey]
    if (value === undefined) {
      return []
    }
    const text = String(value)
    if (LINE_BREAK_PATTERN.test(text)) {
      throw new RangeError(`setting ${JSON.stringify(setting.configKey)} contains a line break`)
    }
    return [`${setting.envVar}=${text}`]
  })
  if (options.timeZone !== undefined && LINE_BREAK_PATTERN.test(options.timeZone)) {
    throw new RangeError('time zone contains a line break')
  }
  const lines = [
    `JAYPOST_PROVIDER=${options.provider.name}`,
    ...settingLines.slice(0, 1),
    `JAYPOST_PORT=${options.port}`,
    ...(options.auth.kind === 'token' ? [`${TOKEN_ENV_VAR}=${options.auth.token}`] : []),
    ...settingLines.slice(1),
    ...(options.timeZone === undefined ? [] : [`TZ=${options.timeZone}`]),
  ]
  return lines.join('\n') + '\n'
}

/**
 * Quadlet .container unit; publishes `port` on loopback only, or on all interfaces when `exposed`,
 * and reads the env file.
 */
export function formatQuadletContainer(options: {
  readonly version: string
  readonly port: number
  readonly envFile: string
  readonly exposed: boolean
}): string {
  return `[Unit]
Description=jaypost service

[Container]
Image=localhost/jaypost:${options.version}
ContainerName=jaypost
Volume=jaypost-data:/data
EnvironmentFile=${quoteSystemdValue(options.envFile)}
PublishPort=${options.exposed ? '' : '127.0.0.1:'}${options.port}:${options.port}

[Service]
Restart=on-failure

[Install]
WantedBy=default.target
`
}

/**
 * User unit that runs the `exec` words (`[node, cli]` or `[binary]`) plus `service run`, with
 * JAYPOST_CONFIG pinned to `config`, and JAYPOST_HOST set to all interfaces when `exposed`.
 */
export function formatSystemdUnit(options: {
  readonly exec: readonly string[]
  readonly config: string
  readonly exposed: boolean
}): string {
  const hostLine = options.exposed ? `Environment=JAYPOST_HOST=${EXPOSED_HOST}\n` : ''
  return `[Unit]
Description=jaypost service
After=network-online.target
Wants=network-online.target

[Service]
Environment=${quoteSystemdValue(`JAYPOST_CONFIG=${options.config}`)}
${hostLine}ExecStart=${options.exec.map(quoteExecWord).join(' ')} service run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

/**
 * Drops a trailing `service run` from command words, or the `start` older units ended with; other
 * words are returned as given.
 */
export function stripServiceRun(words: readonly string[]): readonly string[] {
  if (words.at(-2) === 'service' && words.at(-1) === 'run') {
    return words.slice(0, -2)
  }
  return words.at(-1) === 'start' ? words.slice(0, -1) : words
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function unescapeXml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

/**
 * LaunchAgent plist that runs the `exec` words plus `service run` at load, restarts after a non-zero
 * exit, and logs stdout and stderr to `logFile`. `exposed` adds JAYPOST_HOST for all interfaces. Every value is XML-escaped.
 */
export function formatLaunchdPlist(options: {
  readonly label: string
  readonly exec: readonly string[]
  readonly config: string
  readonly logFile: string
  readonly exposed: boolean
}): string {
  const words = [...options.exec, 'service', 'run']
    .map((word) => `    <string>${escapeXml(word)}</string>`)
    .join('\n')
  const logFile = escapeXml(options.logFile)
  const hostEntry = options.exposed
    ? `\n    <key>JAYPOST_HOST</key>\n    <string>${EXPOSED_HOST}</string>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${words}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JAYPOST_CONFIG</key>
    <string>${escapeXml(options.config)}</string>${hostEntry}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`
}

/**
 * The unescaped `ProgramArguments` words of a plist written by `formatLaunchdPlist`, minus the
 * trailing `service run`; undefined when there's no `ProgramArguments` array.
 */
export function findPlistExecWords(plist: string): readonly string[] | undefined {
  const match = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)
  if (match === null) {
    return undefined
  }
  const words = [...(match[1] ?? '').matchAll(/<string>([\s\S]*?)<\/string>/g)].map((entry) =>
    unescapeXml(entry[1] ?? ''),
  )
  return stripServiceRun(words)
}
