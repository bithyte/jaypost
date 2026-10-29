import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { runServiceStart, runServiceStop } from '../../src/commands/index.ts'
import type { ServiceControlDeps } from '../../src/commands/index.ts'
import { resolveInstallPaths, writeInstall } from '@jaypost/install'
import type { InstallPaths, Target, TargetName } from '@jaypost/install'

let paths: InstallPaths
let out: string[]
let errors: string[]

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'service-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  out = []
  errors = []
})

function fake(name: TargetName): Target {
  return {
    name,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as Target
}

function deps(): ServiceControlDeps {
  return {
    paths,
    targets: {
      quadlet: fake('quadlet'),
      compose: fake('compose'),
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
  }
}

test('service start and stop call the target and fail when nothing is installed', async () => {
  const empty = deps()
  expect(await runServiceStart(empty)).toBe(1)
  expect(await runServiceStop(empty)).toBe(1)
  expect(errors).toEqual([
    'Not installed. Run "jaypost service install".',
    'Not installed. Run "jaypost service install".',
  ])
  expect(empty.targets.systemd.start).not.toHaveBeenCalled()
  writeInstall(paths.installFile, { target: 'compose', port: 9000, version: '1.0.0' })
  const d = deps()
  expect(await runServiceStart(d)).toBe(0)
  expect(d.targets.compose.start).toHaveBeenCalledWith({
    target: 'compose',
    port: 9000,
    version: '1.0.0',
  })
  expect(await runServiceStop(d)).toBe(0)
  expect(d.targets.compose.stop).toHaveBeenCalledWith({
    target: 'compose',
    port: 9000,
    version: '1.0.0',
  })
  expect(out).toEqual(['Started.', 'Stopped.'])
})

test('a failing start or stop prints the error and returns 1', async () => {
  writeInstall(paths.installFile, { target: 'systemd', port: 9000, version: '1.0.0' })
  const d = deps()
  vi.mocked(d.targets.systemd.start).mockRejectedValue(new Error('systemctl start failed (exit 5)'))
  vi.mocked(d.targets.systemd.stop).mockRejectedValue(new Error('systemctl stop failed (exit 5)'))
  expect(await runServiceStart(d)).toBe(1)
  expect(await runServiceStop(d)).toBe(1)
  expect(errors).toEqual([
    "Couldn't start the service: systemctl start failed (exit 5)",
    "Couldn't stop the service: systemctl stop failed (exit 5)",
  ])
  expect(out).toEqual([])
})
