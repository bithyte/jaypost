import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { MAX_ATTACHMENT_BYTES } from '../../src/approval/constants.ts'
import {
  ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  ATTACHMENT_TOO_OLD_MESSAGE,
} from '../../src/client/constants.ts'
import { prepareAttachment } from '../../src/client/attachment.ts'

const OPTIONS = { signal: new AbortController().signal }
let directory = ''
const servers: Server[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-attachment-'))
})

afterEach(async () => {
  rmSync(directory, { recursive: true, force: true })
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

async function startStatusStub(body: object): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, seen }
}

const writeFile = (name: string, bytes: Uint8Array): string => {
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return path
}

const ROOMY = { paired: true, maxAttachmentBytes: 1000 }

test('a path is read and sent as base64 with its basename', async () => {
  const { port } = await startStatusStub(ROOMY)
  const path = writeFile('build.log', new Uint8Array([0, 1, 2]))
  expect(await prepareAttachment(port, { path }, OPTIONS)).toEqual({
    kind: 'ok',
    attachment: { name: 'build.log', data: 'AAEC' },
  })
})

test('a path with a name uses the name', async () => {
  const { port } = await startStatusStub(ROOMY)
  const path = writeFile('build.log', new Uint8Array([0, 1, 2]))
  expect(await prepareAttachment(port, { path, name: 'out.txt' }, OPTIONS)).toEqual({
    kind: 'ok',
    attachment: { name: 'out.txt', data: 'AAEC' },
  })
})

test('a relative path resolves against the working directory', async () => {
  const { port } = await startStatusStub(ROOMY)
  const path = writeFile('rel.bin', new Uint8Array([255]))
  expect(await prepareAttachment(port, { path: relative(process.cwd(), path) }, OPTIONS)).toEqual({
    kind: 'ok',
    attachment: { name: 'rel.bin', data: '/w==' },
  })
})

test('text is sent as text', async () => {
  const { port } = await startStatusStub(ROOMY)
  expect(await prepareAttachment(port, { name: 'a.diff', text: 'x' }, OPTIONS)).toEqual({
    kind: 'ok',
    attachment: { name: 'a.diff', text: 'x' },
  })
})

test('bytes are sent as base64', async () => {
  const { port } = await startStatusStub(ROOMY)
  expect(
    await prepareAttachment(port, { name: 'a.bin', data: new Uint8Array([255]) }, OPTIONS),
  ).toEqual({ kind: 'ok', attachment: { name: 'a.bin', data: '/w==' } })
})

test('stdin is read to the end and sent as base64', async () => {
  const { port } = await startStatusStub(ROOMY)
  const stream = Readable.from([Buffer.from('ab'), 'c'])
  expect(await prepareAttachment(port, { stream, name: 'x.txt' }, OPTIONS)).toEqual({
    kind: 'ok',
    attachment: { name: 'x.txt', data: Buffer.from('abc').toString('base64') },
  })
})

test('a missing file fails without calling the service', async () => {
  const { port, seen } = await startStatusStub(ROOMY)
  const path = join(directory, 'nope.txt')
  expect(await prepareAttachment(port, { path }, OPTIONS)).toEqual({
    kind: 'failed',
    message: `attachment ${JSON.stringify(path)} not found`,
  })
  expect(seen).toEqual([])
})

test('a directory is not a file', async () => {
  const { port, seen } = await startStatusStub(ROOMY)
  const path = join(directory, 'sub')
  mkdirSync(path)
  expect(await prepareAttachment(port, { path }, OPTIONS)).toEqual({
    kind: 'failed',
    message: `attachment ${JSON.stringify(path)} is not a file`,
  })
  expect(seen).toEqual([])
})

test('a file over the cap fails from stat without reading it', async () => {
  const { port } = await startStatusStub(ROOMY)
  const path = writeFile('big.bin', new Uint8Array())
  truncateSync(path, MAX_ATTACHMENT_BYTES + 1)
  chmodSync(path, 0o000)
  expect(await prepareAttachment(port, { path }, OPTIONS)).toEqual({
    kind: 'failed',
    message: `attachment ${JSON.stringify(path)} is over ${MAX_ATTACHMENT_BYTES} bytes`,
  })
})

test('an unreadable file reports the reason', async () => {
  const { port } = await startStatusStub(ROOMY)
  writeFileSync(join(directory, 'file'), 'x')
  const path = join(directory, 'file', 'x')
  const result = await prepareAttachment(port, { path }, OPTIONS)
  expect(result).toEqual({
    kind: 'failed',
    message: expect.stringMatching(/^couldn't read attachment ".*": /),
  })
})

test('stdin over the cap fails and stops reading', async () => {
  const { port } = await startStatusStub(ROOMY)
  let pulled = 0
  async function* zeros(): AsyncGenerator<Uint8Array> {
    for (;;) {
      pulled += 1
      yield new Uint8Array(1_048_576)
    }
  }
  const result = await prepareAttachment(port, { stream: zeros(), name: 'x' }, OPTIONS)
  expect(result).toEqual({
    kind: 'failed',
    message: `attachment from stdin is over ${MAX_ATTACHMENT_BYTES} bytes`,
  })
  expect(pulled).toBeLessThanOrEqual(11)
})

test('an aborted signal ends a stalled stdin read', async () => {
  const { port } = await startStatusStub(ROOMY)
  const controller = new AbortController()
  const stalled: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<never>(() => {}),
    }),
  }
  const pending = prepareAttachment(
    port,
    { stream: stalled, name: 'x' },
    { signal: controller.signal },
  )
  controller.abort()
  expect(await pending).toEqual({
    kind: 'failed',
    message: expect.stringMatching(/^couldn't read attachment from stdin: /),
  })
})

test('an old service without maxAttachmentBytes fails with the upgrade message', async () => {
  const { port } = await startStatusStub({ paired: true })
  expect(await prepareAttachment(port, { name: 'a', text: 'x' }, OPTIONS)).toEqual({
    kind: 'failed',
    message: ATTACHMENT_TOO_OLD_MESSAGE,
  })
})

test('a provider without support fails', async () => {
  const { port } = await startStatusStub({
    paired: true,
    maxAttachmentBytes: 0,
  })
  expect(await prepareAttachment(port, { name: 'a', text: 'x' }, OPTIONS)).toEqual({
    kind: 'failed',
    message: ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  })
})

test('a file over the service limit fails before uploading', async () => {
  const { port, seen } = await startStatusStub({
    paired: true,
    maxAttachmentBytes: 2,
  })
  const path = writeFile('three.bin', new Uint8Array([1, 2, 3]))
  expect(await prepareAttachment(port, { path }, OPTIONS)).toEqual({
    kind: 'failed',
    message: `attachment ${JSON.stringify(path)} is over 2 bytes`,
  })
  expect(seen).toEqual(['GET /status'])
})

test('an unreachable service fails with the not reachable message', async () => {
  const { port } = await startStatusStub(ROOMY)
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
  const result = await prepareAttachment(port, { name: 'a', text: 'x' }, OPTIONS)
  expect(result).toEqual({
    kind: 'failed',
    message: `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  })
})
