import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  AuditLog,
  readAuditFiles,
  removeAuditFiles,
  resolveAuditPath,
} from '../../src/audit/index.ts'

const AT = new Date('2026-10-18T21:41:07.312Z')
const REQUEST = {
  message: { text: '[deploy]\n\nForce-push main?', spans: [] },
  question: 'Force-push main?',
  project: 'deploy',
  allowText: false,
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeoutSeconds: 300,
  attachment: undefined,
}

let directory: string
let path: string
const log = vi.fn()

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tab-audit-'))
  path = join(directory, 'audit.jsonl')
  log.mockReset()
})

const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean)

test('resolveAuditPath puts audit.jsonl next to the config', () => {
  expect(resolveAuditPath('/etc/tab/config.json')).toBe('/etc/tab/audit.jsonl')
})

test('writes the asked and settled lines exactly', () => {
  const audit = new AuditLog(path, { log })
  audit.asked('5f0c', REQUEST, AT)
  audit.settled(
    '5f0c',
    { kind: 'answered', answer: 'Approve' },
    new Date('2026-10-18T21:41:52.004Z'),
  )
  expect(readFileSync(path, 'utf8')).toBe(
    '{"v":1,"event":"asked","id":"5f0c","at":"2026-10-18T21:41:07.312Z","project":"deploy","text":"Force-push main?","options":["Approve","Decline"],"timeoutOption":"Decline","timeoutSeconds":300}\n' +
      '{"v":1,"event":"settled","id":"5f0c","at":"2026-10-18T21:41:52.004Z","outcome":"answered","answer":"Approve"}\n',
  )
})

test('omits project for a request without one and answer for cancelled', () => {
  const audit = new AuditLog(path, { log })
  const { project: _project, ...bare } = REQUEST
  audit.asked('a', bare, AT)
  audit.settled('a', { kind: 'cancelled' }, AT)
  const [asked, settled] = lines(path).map((line) => JSON.parse(line))
  expect(asked).not.toHaveProperty('project')
  expect(settled).toEqual({
    v: 1,
    event: 'settled',
    id: 'a',
    at: AT.toISOString(),
    outcome: 'cancelled',
  })
})

test('creates the directory and the file with mode 0600', () => {
  const nested = join(directory, 'missing', 'audit.jsonl')
  new AuditLog(nested, { log }).asked('a', REQUEST, AT)
  expect(statSync(nested).mode & 0o777).toBe(0o600)
  expect(log).not.toHaveBeenCalled()
})

test('rotates to .1 when the next line would pass maxBytes, replacing an older .1', () => {
  writeFileSync(`${path}.1`, 'stale\n')
  const audit = new AuditLog(path, { log, maxBytes: 300 })
  for (const id of ['a', 'b', 'c', 'd']) {
    audit.settled(id, { kind: 'cancelled' }, AT)
  }
  const rotated = readFileSync(`${path}.1`, 'utf8')
  expect(rotated).not.toContain('stale')
  expect(rotated).toContain('"id":"a"')
  const current = lines(path).map((line) => JSON.parse(line).id)
  expect(current).toContain('d')
  expect(current).not.toContain('a')
  expect([...lines(`${path}.1`), ...lines(path)]).toHaveLength(4)
})

test('takes the starting size from the existing file', () => {
  writeFileSync(path, 'x'.repeat(249) + '\n')
  new AuditLog(path, { log, maxBytes: 300 }).settled('a', { kind: 'cancelled' }, AT)
  expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(249) + '\n')
  expect(lines(path)).toHaveLength(1)
})

test('a line larger than maxBytes on an empty file is written without rotating', () => {
  new AuditLog(path, { log, maxBytes: 10 }).asked('a', REQUEST, AT)
  expect(existsSync(`${path}.1`)).toBe(false)
  expect(lines(path)).toHaveLength(1)
})

test('a file deleted by hand is recreated and its line kept, even when a rotation is due', () => {
  const audit = new AuditLog(path, { log, maxBytes: 250 })
  audit.asked('a', REQUEST, AT)
  removeAuditFiles(path)
  audit.settled('b', { kind: 'cancelled' }, AT)
  audit.settled('c', { kind: 'cancelled' }, AT)
  audit.settled('d', { kind: 'cancelled' }, AT)
  expect(log).not.toHaveBeenCalled()
  const ids = [...(existsSync(`${path}.1`) ? lines(`${path}.1`) : []), ...lines(path)].map(
    (line) => JSON.parse(line).id,
  )
  expect(ids).toEqual(['b', 'c', 'd'])
})

test('an unwritable path does not throw and reports through log', () => {
  const file = join(directory, 'file')
  writeFileSync(file, '')
  const audit = new AuditLog(join(file, 'audit.jsonl'), { log })
  expect(() => audit.asked('a', REQUEST, AT)).not.toThrow()
  expect(log).toHaveBeenCalledWith(
    expect.stringMatching(/^failed to write audit log .*audit\.jsonl: /),
  )
})

test('an invalid date does not throw and reports through log', () => {
  const audit = new AuditLog(path, { log })
  expect(() => audit.asked('a', REQUEST, new Date(Number.NaN))).not.toThrow()
  expect(log).toHaveBeenCalledTimes(1)
})

test('readAuditFiles returns .1 then current, empty string when neither exists', () => {
  expect(readAuditFiles(path)).toBe('')
  writeFileSync(path, 'new\n')
  expect(readAuditFiles(path)).toBe('new\n')
  writeFileSync(`${path}.1`, 'old\n')
  expect(readAuditFiles(path)).toBe('old\nnew\n')
})

test('readAuditFiles adds a newline after a .1 that lacks one', () => {
  writeFileSync(`${path}.1`, 'old')
  writeFileSync(path, 'new\n')
  expect(readAuditFiles(path)).toBe('old\nnew\n')
})

test('readAuditFiles throws a readable error for an unreadable file', () => {
  if (process.getuid?.() === 0) {
    return
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, 'x\n')
  chmodSync(path, 0o000)
  expect(() => readAuditFiles(path)).toThrow(
    new RegExp(
      `^couldn't read the log ${JSON.stringify(path).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `,
    ),
  )
})

test('removeAuditFiles deletes both files and is fine when they are missing', () => {
  expect(() => removeAuditFiles(path)).not.toThrow()
  writeFileSync(path, 'a\n')
  writeFileSync(`${path}.1`, 'b\n')
  removeAuditFiles(path)
  expect(existsSync(path)).toBe(false)
  expect(existsSync(`${path}.1`)).toBe(false)
})
