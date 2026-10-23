import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import {
  formatComposeYaml,
  formatDockerfile,
  formatEnvFile,
  formatLaunchdPlist,
  findPlistExecWords,
  formatQuadletContainer,
  quoteSystemdValue,
  formatSystemdUnit,
} from '../../src/install/index.ts'
import { NO_AUTH, realExec } from '@jaypost/store'
import { telegramProvider } from '@jaypost/providers'
import { createFakeProvider } from '@jaypost/testing'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

test('formatDockerfile pins version', () =>
  expect(formatDockerfile({ version: '0.1.0' })).toContain('npm i -g jaypost@0.1.0'))
test('formatDockerfile from tarball', () => {
  const d = formatDockerfile({ version: '0.1.0', tarball: '/a/b/pkg.tgz' })
  expect(d).toContain('COPY pkg.tgz /tmp/pkg.tgz')
  expect(d).toContain('RUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz')
})
test('formatDockerfile binds all interfaces inside', () => {
  const d = formatDockerfile({ version: '1' })
  expect(d).toContain('JAYPOST_HOST=0.0.0.0')
  expect(d).toContain('CMD ["jaypost","start"]')
})
test('compose publishes on localhost only, restarts', () => {
  const y = formatComposeYaml(9000)
  expect(y).toContain('"127.0.0.1:9000:9000"')
  expect(y).toContain('restart: unless-stopped')
  expect(y).toContain('data:/data')
})
test('quadlet publishes on localhost and quotes the env file path', () => {
  const q = formatQuadletContainer({ version: '0.1.0', port: 8787, envFile: '/home/a b/.env' })
  expect(q).toContain('PublishPort=127.0.0.1:8787:8787')
  expect(q).toContain('EnvironmentFile="/home/a b/.env"')
  expect(q).toContain('Image=localhost/jaypost:0.1.0')
})
test('systemd unit quotes paths with spaces and percent', () => {
  const u = formatSystemdUnit({
    exec: ['/opt/node 24/bin/node', '/x/cli.js'],
    config: '/h/50%/c.json',
  })
  expect(u).toContain('ExecStart="/opt/node 24/bin/node" "/x/cli.js" start')
  expect(u).toContain('Environment="JAYPOST_CONFIG=/h/50%%/c.json"')
  expect(u).not.toContain('WorkingDirectory')
})
test('systemd unit escapes $ in ExecStart only', () => {
  const u = formatSystemdUnit({
    exec: ['/n$x/node', '/c$y/cli.js'],
    config: '/h/$z/c.json',
  })
  expect(u).toContain('ExecStart="/n$$x/node" "/c$$y/cli.js" start')
  expect(u).toContain('Environment="JAYPOST_CONFIG=/h/$z/c.json"')
})
test('systemd unit with a single exec word runs it directly', () => {
  const u = formatSystemdUnit({ exec: ['/h/.local/bin/jaypost'], config: '/h/c.json' })
  expect(u).toContain('ExecStart="/h/.local/bin/jaypost" start\n')
})
test('quoteSystemdValue escapes backslash and quote', () =>
  expect(quoteSystemdValue('a\\b"c%')).toBe('"a\\\\b\\"c%%"'))
test('formatEnvFile writes the provider, its settings and the port', () =>
  expect(
    formatEnvFile({
      provider: telegramProvider,
      port: 8787,
      settings: { botToken: 't', ownerId: 42 },
      auth: NO_AUTH,
    }),
  ).toBe(
    'JAYPOST_PROVIDER=telegram\nJAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=8787\nJAYPOST_OWNER_ID=42\n',
  ))
test('formatEnvFile writes the api token right after JAYPOST_PORT', () =>
  expect(
    formatEnvFile({
      provider: telegramProvider,
      port: 8787,
      settings: { botToken: 't', ownerId: 42 },
      auth: { kind: 'token', token: TOKEN },
    }),
  ).toBe(
    `JAYPOST_PROVIDER=telegram\nJAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=8787\nJAYPOST_TOKEN=${TOKEN}\nJAYPOST_OWNER_ID=42\n`,
  ))
test('formatDockerfile never carries the token', () =>
  expect(formatDockerfile({ version: '0.1.0' })).not.toContain('JAYPOST_TOKEN'))
test('formatEnvFile omits JAYPOST_OWNER_ID when unknown', () =>
  expect(
    formatEnvFile({
      provider: telegramProvider,
      port: 8787,
      settings: { botToken: 't' },
      auth: NO_AUTH,
    }),
  ).toBe('JAYPOST_PROVIDER=telegram\nJAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=8787\n'))
test('formatEnvFile works for any provider', () =>
  expect(
    formatEnvFile({
      provider: createFakeProvider(),
      port: 1,
      settings: { fakeKey: 'k' },
      auth: NO_AUTH,
    }),
  ).toBe('JAYPOST_PROVIDER=fake\nFAKE_KEY=k\nJAYPOST_PORT=1\n'))
test('formatEnvFile ends with TZ when a zone is given', () =>
  expect(
    formatEnvFile({
      provider: telegramProvider,
      port: 8787,
      settings: { botToken: 't', ownerId: 42 },
      auth: NO_AUTH,
      timeZone: 'Europe/Bucharest',
    }),
  ).toBe(
    'JAYPOST_PROVIDER=telegram\nJAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=8787\nJAYPOST_OWNER_ID=42\nTZ=Europe/Bucharest\n',
  ))
test('formatEnvFile rejects a zone with a line break', () => {
  const format = () =>
    formatEnvFile({
      provider: telegramProvider,
      port: 1,
      settings: { botToken: 't' },
      auth: NO_AUTH,
      timeZone: 'UTC\nJAYPOST_PORT=1',
    })
  expect(format).toThrow(RangeError)
  expect(format).toThrow('time zone contains a line break')
})
test('formatEnvFile rejects a value with a newline', () => {
  for (const botToken of ['a\nJAYPOST_OWNER_ID=1', 'a\rb']) {
    const format = () =>
      formatEnvFile({ provider: telegramProvider, port: 1, settings: { botToken }, auth: NO_AUTH })
    expect(format).toThrow(RangeError)
    expect(format).toThrow('setting "botToken" contains a line break')
  }
})

test('formatLaunchdPlist writes the agent plist', () => {
  expect(
    formatLaunchdPlist({
      label: 'io.github.bithyte.jaypost',
      exec: ['/h/.local/bin/jaypost'],
      config: '/h/.config/jaypost/config.json',
      logFile: '/h/Library/Logs/jaypost/jaypost.log',
    }),
  ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.bithyte.jaypost</string>
  <key>ProgramArguments</key>
  <array>
    <string>/h/.local/bin/jaypost</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JAYPOST_CONFIG</key>
    <string>/h/.config/jaypost/config.json</string>
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
  <string>/h/Library/Logs/jaypost/jaypost.log</string>
  <key>StandardErrorPath</key>
  <string>/h/Library/Logs/jaypost/jaypost.log</string>
</dict>
</plist>
`)
})

test('formatLaunchdPlist escapes & < > in every value', () => {
  const plist = formatLaunchdPlist({
    label: 'l',
    exec: ['/a&b/<n>/node', '/c.js'],
    config: '/x&y/c.json',
    logFile: '/l<g>.log',
  })
  expect(plist).toContain('<string>/a&amp;b/&lt;n&gt;/node</string>')
  expect(plist).toContain('<string>/x&amp;y/c.json</string>')
  expect(plist).toContain('<string>/l&lt;g&gt;.log</string>')
})

test('findPlistExecWords undoes formatLaunchdPlist', () => {
  const words = ['/a b/&amp;/<x>/node', '/c.js']
  const plist = formatLaunchdPlist({ label: 'l', exec: words, config: '/c', logFile: '/l' })
  expect(findPlistExecWords(plist)).toEqual(words)
  expect(findPlistExecWords('<plist><dict></dict></plist>')).toBeUndefined()
})

test.skipIf(process.platform !== 'darwin')(
  'plutil accepts the plist with awkward paths',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plist-'))
    const file = join(dir, 'a.plist')
    await writeFile(
      file,
      formatLaunchdPlist({
        label: 'io.github.bithyte.jaypost',
        exec: ['/a & b/<n>/node', '/c d/cli.js'],
        config: '/x & y/<c>/config.json',
        logFile: '/l & <g>/my log.log',
      }),
    )
    expect((await realExec('plutil', ['-lint', file])).code).toBe(0)
  },
)
