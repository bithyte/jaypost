import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vite-plus/test'
import { OWNER_COMMANDS } from '../../src/approval/index.ts'
import type { RuntimeHandlers } from '../../src/provider/index.ts'
import { createTerminalRuntime } from '../../src/terminal/index.ts'

function handlers(answerResult: 'accepted' | 'expired') {
  return {
    answer: vi.fn((_id: string, _optionIndex: number) => answerResult),
    reply: vi.fn((_id: string, _text: string) => 'accepted' as const),
    dismiss: vi.fn(() => true),
    commands: OWNER_COMMANDS,
    command: vi.fn((_name: string, _argument: string): string | undefined => undefined),
    fatal: vi.fn<(message: string) => void>(),
  } satisfies RuntimeHandlers
}

function setup(answerResult: 'accepted' | 'expired' = 'accepted') {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ''
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString()
  })
  const runtime = createTerminalRuntime({ input, output })
  const handled = handlers(answerResult)
  runtime.start(handled)
  return {
    runtime,
    handlers: handled,
    type: async (line: string) => {
      input.write(`${line}\n`)
      await flush()
    },
    output: () => written,
    clear: () => {
      written = ''
    },
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

const plain = (text: string) => ({ text, spans: [] })

test('credentials always pass and there is no pairing', async () => {
  const runtime = createTerminalRuntime({ input: new PassThrough(), output: new PassThrough() })
  expect(await runtime.checkCredentials()).toEqual({ ok: true, displayName: 'terminal' })
  expect(runtime.pairingInstructions).toBeUndefined()
})

test('start prints how to answer', () => {
  const { output } = setup()
  expect(output()).toContain('type an option number or a reply')
})

test('a request prints its number, text and numbered options', async () => {
  const { runtime, output, clear } = setup()
  clear()
  await runtime.sendRequest('r1', plain('[demo]\nShip it?'), ['Yes', 'No'], false, undefined)
  expect(output()).toBe('\n#1 [demo]\nShip it?\n   1) Yes   2) No\n')
})

test('a request that allows text says so', async () => {
  const { runtime, output, clear } = setup()
  clear()
  await runtime.sendRequest('r1', plain('Name?'), ['Skip'], true, undefined)
  expect(output()).toContain('1) Skip   (or type a reply)')
})

test('an attachment prints its name and size', async () => {
  const { runtime, output, clear } = setup()
  clear()
  const attachment = { name: 'log.txt', content: new Uint8Array(12) }
  await runtime.sendRequest('r1', plain('See log'), ['Ok'], false, attachment)
  expect(output()).toContain('   attached: log.txt (12 bytes)\n')
})

test('typing an option number answers the only open question', async () => {
  const { runtime, type, handlers } = setup()
  await runtime.sendRequest('r1', plain('Ship it?'), ['Yes', 'No'], false, undefined)
  await type('2')
  expect(handlers.answer.mock.calls).toEqual([['r1', 1]])
})

test('typed text is a reply when the question allows it', async () => {
  const { runtime, type, handlers } = setup()
  await runtime.sendRequest('r1', plain('Name?'), ['Skip'], true, undefined)
  await type('  Alice  ')
  expect(handlers.reply.mock.calls).toEqual([['r1', 'Alice']])
  expect(handlers.answer).not.toHaveBeenCalled()
})

test('text for a buttons-only question asks for an option number', async () => {
  const { runtime, type, handlers, output, clear } = setup()
  await runtime.sendRequest('r1', plain('Ship it?'), ['Yes', 'No'], false, undefined)
  clear()
  await type('maybe')
  expect(output()).toBe('#1 needs an option number from 1 to 2\n')
  expect(handlers.reply).not.toHaveBeenCalled()
})

test('an out-of-range number is a reply when text is allowed, else an error', async () => {
  const { runtime, type, handlers, output, clear } = setup()
  await runtime.sendRequest('r1', plain('Count?'), ['Skip'], true, undefined)
  await type('3')
  expect(handlers.reply.mock.calls).toEqual([['r1', '3']])
  await runtime.sendRequest('r2', plain('Ship it?'), ['Yes'], false, undefined)
  clear()
  await type('#2 3')
  expect(output()).toBe('#2 needs an option number from 1 to 1\n')
})

test('with several open questions a #number prefix picks one', async () => {
  const { runtime, type, handlers, output, clear } = setup()
  await runtime.sendRequest('r1', plain('First?'), ['A', 'B'], false, undefined)
  await runtime.sendRequest('r2', plain('Second?'), ['C', 'D'], true, undefined)
  clear()
  await type('1')
  expect(output()).toBe('several questions are open; start with the number, like "#1 1"\n')
  await type('#1 2')
  await type('#2 free text')
  expect(handlers.answer.mock.calls).toEqual([['r1', 1]])
  expect(handlers.reply.mock.calls).toEqual([['r2', 'free text']])
})

test('an unknown #number says it is not open', async () => {
  const { runtime, type, output, clear } = setup()
  await runtime.sendRequest('r1', plain('Ship it?'), ['Yes'], false, undefined)
  clear()
  await type('#7 1')
  expect(output()).toBe('#7 is not open\n')
})

test('an answer the service no longer takes says it is not open', async () => {
  const { runtime, type, output, clear } = setup('expired')
  await runtime.sendRequest('r1', plain('Ship it?'), ['Yes'], false, undefined)
  clear()
  await type('1')
  expect(output()).toBe('#1 is not open\n')
})

test('input with nothing open says so', async () => {
  const { type, output, clear } = setup()
  clear()
  await type('1')
  expect(output()).toBe('no open questions\n')
})

test('blank lines are ignored', async () => {
  const { type, output, clear } = setup()
  clear()
  await type('   ')
  expect(output()).toBe('')
})

test('finalize prints the ending and closes the question', async () => {
  const { runtime, type, output, clear } = setup()
  const reference = await runtime.sendRequest('r1', plain('Ship it?'), ['Yes'], false, undefined)
  clear()
  await runtime.finalize?.(reference, plain('Ship it?'), { kind: 'answered', answer: 'Yes' })
  expect(output()).toBe('#1 answered: Yes\n')
  clear()
  await type('1')
  expect(output()).toBe('no open questions\n')
})

test('finalize describes every ending', async () => {
  const { runtime, output, clear } = setup()
  const endings = [
    { kind: 'timedOut', answer: 'No' },
    { kind: 'rejected', answer: 'No' },
    { kind: 'replied', answer: 'hi' },
    { kind: 'cancelled' },
    { kind: 'expired' },
  ] as const
  const lines = []
  for (const ending of endings) {
    const reference = await runtime.sendRequest('r', plain('Q'), ['No'], true, undefined)
    clear()
    await runtime.finalize?.(reference, plain('Q'), ending)
    lines.push(output())
  }
  expect(lines).toEqual([
    '#1 timed out: No\n',
    '#2 rejected: No\n',
    '#3 replied: hi\n',
    '#4 cancelled\n',
    '#5 expired\n',
  ])
})

test("finalize for a previous run's question leaves a new one with the same number open", async () => {
  const { runtime, type, handlers } = setup()
  await runtime.sendRequest('new', plain('Ship it?'), ['Yes'], false, undefined)
  await runtime.finalize?.({ number: 1, id: 'old' }, plain('Old'), { kind: 'expired' })
  await type('1')
  expect(handlers.answer.mock.calls).toEqual([['new', 0]])
})

test('a notification prints its text', async () => {
  const { runtime, output, clear } = setup()
  clear()
  await runtime.sendNotification?.(
    'n1',
    plain('Deployed'),
    { silent: false, dismissible: true },
    undefined,
  )
  expect(output()).toBe('\nnotification: Deployed\n')
})

test('a slash command runs and prints its reply', async () => {
  const { type, output, clear, handlers } = setup()
  handlers.command.mockReturnValue('nothing pending')
  clear()
  await type('/pending')
  await type('/cancel  abc ')
  expect(handlers.command.mock.calls).toEqual([
    ['pending', ''],
    ['cancel', 'abc'],
  ])
  expect(output()).toBe('nothing pending\nnothing pending\n')
})

test('an unknown slash command lists the known ones', async () => {
  const { type, output, clear } = setup()
  clear()
  await type('/nope')
  expect(output()).toBe(
    `unknown command; try ${OWNER_COMMANDS.map((command) => `/${command.name}`).join(' ')}\n`,
  )
})

test('stop stops reading input', async () => {
  const { runtime, type, handlers } = setup()
  await runtime.sendRequest('r1', plain('Ship it?'), ['Yes'], false, undefined)
  await runtime.stop()
  await type('1')
  expect(handlers.answer).not.toHaveBeenCalled()
})
