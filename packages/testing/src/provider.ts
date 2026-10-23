import type {
  Attachment,
  FormattedText,
  Provider,
  ProviderRuntime,
  ProviderSetting,
  RuntimeHandlers,
} from '@jaypost/core'

export type FakeRuntime = ProviderRuntime & {
  readonly sent: {
    id: string
    message: FormattedText
    options: readonly string[]
    allowText: boolean
    attachment: Attachment | undefined
    recipient: string | undefined
  }[]
  handlers: RuntimeHandlers | undefined
}

const parseNonEmpty = (raw: unknown) => (typeof raw === 'string' && raw !== '' ? raw : undefined)

const FAKE_KEY_SETTING: ProviderSetting = {
  configKey: 'fakeKey',
  envVar: 'FAKE_KEY',
  description: 'fake key',
  secret: true,
  owner: false,
  required: true,
  prompt: 'Fake key',
  parse: parseNonEmpty,
}

export function createFakeProvider(
  overrides: Partial<Provider> & { readonly runtime?: Partial<ProviderRuntime> } = {},
): Provider & { readonly runtimes: FakeRuntime[] } {
  const { runtime: runtimeOverrides, ...providerOverrides } = overrides
  const runtimes: FakeRuntime[] = []
  let counter = 0
  return {
    name: 'fake',
    label: 'Fake',
    maxTextLength: 100,
    settings: [FAKE_KEY_SETTING],
    setup: {
      checkCredentials: async () => ({ ok: true, displayName: 'fake' }),
      text: {
        leftoverFound: 'Found a fake key kept from an earlier install.',
        reusing: (displayName) => `Reusing the saved fake key (${displayName}).`,
        rejected: 'Fake rejected that key. Try again.',
      },
    },
    createRuntime: () => {
      const runtime: FakeRuntime = {
        sent: [],
        handlers: undefined,
        checkCredentials: async () => ({ ok: true, displayName: 'fake' }),
        sendRequest: async (id, message, options, allowText, attachment, recipient) => {
          runtime.sent.push({ id, message, options, allowText, attachment, recipient })
          counter += 1
          return { n: counter }
        },
        start: (handlers) => {
          runtime.handlers = handlers
        },
        stop: async () => {},
        ...runtimeOverrides,
      }
      runtimes.push(runtime)
      return runtime
    },
    ...providerOverrides,
    runtimes,
  }
}

export function createPairingFakeProvider(): Provider & { readonly runtimes: FakeRuntime[] } {
  const base = createFakeProvider()
  return createFakeProvider({
    name: 'fakepair',
    label: 'Fake pair',
    settings: [
      ...base.settings,
      {
        configKey: 'fakeOwner',
        envVar: 'FAKE_OWNER',
        description: 'fake owner',
        secret: false,
        owner: true,
        required: false,
        parse: parseNonEmpty,
      },
    ],
    setup: {
      ...base.setup,
      text: { ...base.setup.text, resetOwnerWarning: 'This unlinks your Fake account.' },
    },
    runtime: { pairingInstructions: (code) => `Say ${code} to fake` },
  })
}
