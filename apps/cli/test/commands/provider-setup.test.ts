import { expect, test, vi } from 'vite-plus/test'
import { resolveProviderSettings, selectProvider } from '../../src/commands/index.ts'
import type { Prompts } from '../../src/commands/index.ts'
import { terminalProvider } from '@jaypost/providers'
import { createFakeProvider } from '@jaypost/testing'

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

test('typed answers reach the credential check parsed, or raw when parse refuses them', async () => {
  const checked: unknown[] = []
  const base = createFakeProvider()
  const provider = createFakeProvider({
    settings: [
      ...base.settings,
      {
        configKey: 'fakeUrl',
        envVar: 'FAKE_URL',
        description: 'fake url',
        secret: false,
        owner: false,
        required: false,
        prompt: 'Fake url',
        parse: (raw) =>
          typeof raw === 'string' && raw.endsWith('/') ? raw.slice(0, -1) : undefined,
      },
    ],
    setup: {
      ...base.setup,
      checkCredentials: async (settings) => {
        checked.push(settings)
        return checked.length === 1
          ? { ok: false, reason: 'bad url' }
          : { ok: true, displayName: 'fake' }
      },
    },
  })
  const prompt = prompts()
  vi.mocked(prompt.text).mockResolvedValueOnce('not-a-url').mockResolvedValueOnce('https://x/')
  const result = await resolveProviderSettings({
    provider,
    saved: {},
    prompt,
    print: () => {},
    seen: [],
  })
  expect(checked).toEqual([
    { fakeKey: 'typed-key', fakeUrl: 'not-a-url' },
    { fakeKey: 'typed-key', fakeUrl: 'https://x' },
  ])
  expect(result).toEqual({
    kind: 'accepted',
    settings: { fakeKey: 'typed-key', fakeUrl: 'https://x' },
    displayName: 'fake',
  })
})
