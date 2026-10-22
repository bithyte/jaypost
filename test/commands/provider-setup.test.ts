import { expect, test, vi } from 'vite-plus/test'
import { resolveProviderSettings, selectProvider } from '../../src/commands/index.ts'
import type { Prompts } from '../../src/commands/index.ts'
import { terminalProvider } from '../../src/terminal/index.ts'
import { createFakeProvider } from '../provider/fake.ts'

function prompts(): Prompts {
  return {
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => 'typed-key'),
    text: vi.fn(async () => 'text-answer'),
    select: vi.fn(async (_q, _o, initialValue) => initialValue),
  }
}

test('select preselects the given provider over the first one', async () => {
  const prompt = prompts()
  const providers = [createFakeProvider(), terminalProvider]
  expect(await selectProvider(providers, prompt.select, 'terminal')).toBe(terminalProvider)
  expect(vi.mocked(prompt.select).mock.calls).toEqual([
    [
      'Which chat app should the bot use?',
      [
        { value: 'fake', label: 'Fake' },
        { value: 'terminal', label: 'Terminal' },
      ],
      'terminal',
    ],
  ])
})

test('select falls back to the first provider for an unknown preselected name', async () => {
  const prompt = prompts()
  const providers = [createFakeProvider(), terminalProvider]
  expect(await selectProvider(providers, prompt.select, 'gone')).toBe(providers[0])
  expect(vi.mocked(prompt.select).mock.calls[0]?.[2]).toBe('fake')
})

test('a provider with no settings is accepted without asking or printing', async () => {
  const prompt = prompts()
  const out: string[] = []
  const result = await resolveProviderSettings({
    provider: terminalProvider,
    saved: {},
    prompt,
    print: (text) => out.push(text),
    seen: [],
  })
  expect(result).toEqual({ kind: 'accepted', settings: {} })
  expect(out).toEqual([])
  expect(prompt.password).not.toHaveBeenCalled()
  expect(prompt.text).not.toHaveBeenCalled()
})

test('a provider with no settings and failing credentials is rejected', async () => {
  const provider = {
    ...terminalProvider,
    setup: {
      ...terminalProvider.setup,
      checkCredentials: async () => ({ ok: false as const, reason: 'no' }),
    },
  }
  const out: string[] = []
  const result = await resolveProviderSettings({
    provider,
    saved: {},
    prompt: prompts(),
    print: (text) => out.push(text),
    seen: [],
  })
  expect(result).toEqual({ kind: 'rejected' })
  expect(out).toEqual([provider.setup.text.rejected])
})
