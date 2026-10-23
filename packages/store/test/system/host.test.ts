import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import type { Exec } from '../../src/system/index.ts'
import { ensureLinger, isPortFree } from '../../src/system/index.ts'

test('isPortFree false while held, true after', async () => {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  expect(await isPortFree(port)).toBe(false)
  await new Promise((r) => s.close(r))
  expect(await isPortFree(port)).toBe(true)
})

const res = (code: number, stdout = '') => ({ code, stdout, stderr: '' })

test('ensureLinger enables only when Linger=no', async () => {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    return args[0] === 'show-user' ? res(0, 'Linger=no\n') : res(0)
  }
  await ensureLinger(exec, 'bob', () => {})
  expect(calls).toEqual([
    ['loginctl', 'show-user', 'bob', '-p', 'Linger'],
    ['loginctl', 'enable-linger', 'bob'],
  ])
})

test('ensureLinger skips when Linger=yes', async () => {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    return res(0, 'Linger=yes\n')
  }
  await ensureLinger(exec, 'bob', () => {})
  expect(calls).toHaveLength(1)
})

test('ensureLinger prints fallback on failure', async () => {
  const print = vi.fn()
  const exec: Exec = async (_c, args) => (args[0] === 'show-user' ? res(0, 'Linger=no\n') : res(1))
  await ensureLinger(exec, 'bob', print)
  expect(print).toHaveBeenCalledWith(
    'Run "loginctl enable-linger bob" so it keeps running after logout.',
  )
})

test('ensureLinger prints fallback when loginctl is missing', async () => {
  const print = vi.fn()
  const exec: Exec = async () => {
    throw new Error('missing')
  }
  await ensureLinger(exec, 'bob', print)
  expect(print).toHaveBeenCalledOnce()
})
