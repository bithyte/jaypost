import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, test } from 'vite-plus/test'

const SCRIPT = join(import.meta.dirname, '..', 'install.sh')
const BINARY = '#!/bin/sh\necho fake jaypost "$@"\n'

type RunResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const directories: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  for (const server of servers.splice(0)) {
    server.close()
  }
})

function createReleaseFiles(asset: string, sums?: string): Record<string, Buffer> {
  const gzipped = gzipSync(BINARY)
  const hash = createHash('sha256').update(gzipped).digest('hex')
  return {
    [`/${asset}`]: gzipped,
    '/SHA256SUMS': Buffer.from(sums ?? `${hash}  ${asset}\n`),
  }
}

async function startRelease(files: Record<string, Buffer>): Promise<string> {
  const server = createServer((request, response) => {
    const body = files[request.url ?? '']
    response.statusCode = body === undefined ? 404 : 200
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function createHome(system: string, machine: string): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), 'jaypost-install-'))
  directories.push(home)
  const fakeBin = join(home, 'fake-bin')
  mkdirSync(fakeBin)
  writeFileSync(
    join(fakeBin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
  )
  chmodSync(join(fakeBin, 'uname'), 0o755)
  return { home, path: `${fakeBin}:${process.env.PATH ?? ''}` }
}

// detached starts a new session, so the script has no /dev/tty and skips init
function runScript(
  home: string,
  path: string,
  releaseUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [SCRIPT], {
      detached: true,
      env: { HOME: home, PATH: path, JAYPOST_RELEASE_URL: releaseUrl, ...extraEnv },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('installs the binary for the platform into ~/.local/bin', async () => {
  const releaseUrl = await startRelease(createReleaseFiles('jaypost-linux-x64.gz'))
  const { home, path } = createHome('Linux', 'x86_64')
  const result = await runScript(home, path, releaseUrl)
  expect(result.status, result.stderr).toBe(0)
  const binary = join(home, '.local', 'bin', 'jaypost')
  expect(readFileSync(binary, 'utf8')).toBe(BINARY)
  expect(statSync(binary).mode & 0o111).not.toBe(0)
  expect(readdirSync(join(home, '.local', 'bin'))).toEqual(['jaypost'])
  expect(result.stdout).toContain(`run ${binary} init`)
})

test('picks the arm64 binary on aarch64', async () => {
  const releaseUrl = await startRelease(createReleaseFiles('jaypost-linux-arm64.gz'))
  const { home, path } = createHome('Linux', 'aarch64')
  const result = await runScript(home, path, releaseUrl)
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(home, '.local', 'bin', 'jaypost'), 'utf8')).toBe(BINARY)
})

test('picks the darwin binary on macos', async () => {
  const releaseUrl = await startRelease(createReleaseFiles('jaypost-darwin-arm64.gz'))
  const { home, path } = createHome('Darwin', 'arm64')
  const result = await runScript(home, path, releaseUrl)
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(home, '.local', 'bin', 'jaypost'), 'utf8')).toBe(BINARY)
})

test('keeps the old binary when the checksum does not match', async () => {
  const releaseUrl = await startRelease(
    createReleaseFiles('jaypost-linux-x64.gz', `${'0'.repeat(64)}  jaypost-linux-x64.gz\n`),
  )
  const { home, path } = createHome('Linux', 'x86_64')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(home, '.local', 'bin', 'jaypost'), 'old')
  const result = await runScript(home, path, releaseUrl)
  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    "jaypost install: checksum of jaypost-linux-x64.gz doesn't match SHA256SUMS\n",
  )
  expect(readFileSync(join(home, '.local', 'bin', 'jaypost'), 'utf8')).toBe('old')
})

test('fails when SHA256SUMS does not list the binary', async () => {
  const releaseUrl = await startRelease(createReleaseFiles('jaypost-linux-x64.gz', ''))
  const { home, path } = createHome('Linux', 'x86_64')
  const result = await runScript(home, path, releaseUrl)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("doesn't match SHA256SUMS")
})

test('says the release may still be uploading when a file is missing', async () => {
  const releaseUrl = await startRelease({})
  const { home, path } = createHome('Linux', 'x86_64')
  const result = await runScript(home, path, releaseUrl)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('may still be uploading')
})

test('points to npx on an unsupported os', async () => {
  const { home, path } = createHome('MINGW64_NT-10.0', 'x86_64')
  const result = await runScript(home, path, 'http://127.0.0.1:9')
  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    'jaypost install: no binary for MINGW64_NT-10.0; use npx jaypost init instead (needs Node 24.15+)\n',
  )
})

test('points to npx on an unsupported architecture', async () => {
  const { home, path } = createHome('Linux', 'riscv64')
  const result = await runScript(home, path, 'http://127.0.0.1:9')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('no binary for riscv64; use npx jaypost init')
})

test('installs into JAYPOST_INSTALL_DIR when set', async () => {
  const releaseUrl = await startRelease(createReleaseFiles('jaypost-linux-x64.gz'))
  const { home, path } = createHome('Linux', 'x86_64')
  const installDir = join(home, 'tool')
  const result = await runScript(home, path, releaseUrl, { JAYPOST_INSTALL_DIR: installDir })
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(installDir, 'jaypost'), 'utf8')).toBe(BINARY)
  expect(existsSync(join(home, '.local'))).toBe(false)
})

test('stops after installing when JAYPOST_NO_INIT is 1', async () => {
  const releaseUrl = await startRelease(createReleaseFiles('jaypost-linux-x64.gz'))
  const { home, path } = createHome('Linux', 'x86_64')
  const result = await runScript(home, path, releaseUrl, { JAYPOST_NO_INIT: '1' })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toContain('init')
})
