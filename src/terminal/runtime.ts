import { createInterface } from 'node:readline'
import type { Attachment, MessageEnding, MessageReference } from '../approval/index.ts'
import type { FormattedText } from '../format/index.ts'
import type { ProviderRuntime, RuntimeHandlers } from '../provider/index.ts'
import { OPTION_NUMBER_PATTERN, QUESTION_PREFIX_PATTERN, TERMINAL_INTRO } from './constants.ts'
import type { OpenQuestion, TerminalIo, TerminalReference } from './types.ts'

function isTerminalReference(value: unknown): value is TerminalReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'number' in value &&
    typeof value.number === 'number' &&
    'id' in value &&
    typeof value.id === 'string'
  )
}

function describeEnding(ending: MessageEnding): string {
  switch (ending.kind) {
    case 'answered':
      return `answered: ${ending.answer}`
    case 'timedOut':
      return `timed out: ${ending.answer}`
    case 'rejected':
      return `rejected: ${ending.answer}`
    case 'replied':
      return `replied: ${ending.answer}`
    case 'cancelled':
      return 'cancelled'
    case 'expired':
      return 'expired'
    case 'closed':
      return `decided: ${ending.answer}`
    case 'reasked':
      return 're-asked'
  }
}

function formatAttachment(attachment: Attachment | undefined): string {
  return attachment === undefined
    ? ''
    : `   attached: ${attachment.name} (${attachment.content.byteLength} bytes)\n`
}

/**
 * A provider that asks in the terminal it runs in, for trying the service without a bot. Questions
 * are numbered from 1 per run; answers are typed lines. Needs no credentials and never pairs.
 */
export function createTerminalRuntime(io: TerminalIo): ProviderRuntime {
  const openQuestions = new Map<number, OpenQuestion>()
  let lastNumber = 0
  let lines: ReturnType<typeof createInterface> | undefined
  function print(text: string): void {
    io.output.write(text)
  }
  function answer(handlers: RuntimeHandlers, number: number, rawAnswer: string): void {
    const question = openQuestions.get(number)
    if (question === undefined) {
      print(`#${number} is not open\n`)
      return
    }
    const text = rawAnswer.trim()
    const optionNumber = OPTION_NUMBER_PATTERN.test(text) ? Number(text) : 0
    const isOption = optionNumber >= 1 && optionNumber <= question.options.length
    if (!isOption && !question.allowText) {
      print(`#${number} needs an option number from 1 to ${question.options.length}\n`)
      return
    }
    const result = isOption
      ? handlers.answer(question.id, optionNumber - 1)
      : handlers.reply(question.id, text)
    if (result === 'expired') {
      print(`#${number} is not open\n`)
    }
  }
  function runCommand(handlers: RuntimeHandlers, line: string): void {
    const [name = '', ...rest] = line.slice(1).split(/\s+/)
    if (!handlers.commands.some((command) => command.name === name)) {
      const names = handlers.commands.map((command) => `/${command.name}`).join(' ')
      print(`unknown command; try ${names}\n`)
      return
    }
    const reply = handlers.command(name, rest.join(' ').trim())
    if (reply !== undefined) {
      print(`${reply}\n`)
    }
  }
  function handleLine(handlers: RuntimeHandlers, rawLine: string): void {
    const line = rawLine.trim()
    if (line === '') {
      return
    }
    if (line.startsWith('/')) {
      runCommand(handlers, line)
      return
    }
    const prefixed = QUESTION_PREFIX_PATTERN.exec(line)
    if (prefixed !== null) {
      answer(handlers, Number(prefixed[1]), prefixed[2] ?? '')
      return
    }
    const [only, ...others] = openQuestions.keys()
    if (only === undefined) {
      print('no open questions\n')
      return
    }
    if (others.length > 0) {
      print(`several questions are open; start with the number, like "#${only} 1"\n`)
      return
    }
    answer(handlers, only, line)
  }
  return {
    checkCredentials: () => Promise.resolve({ ok: true, displayName: 'terminal' }),
    sendRequest(
      id: string,
      message: FormattedText,
      options: readonly string[],
      allowText: boolean,
      attachment: Attachment | undefined,
    ): Promise<MessageReference> {
      lastNumber += 1
      const number = lastNumber
      openQuestions.set(number, { id, options, allowText })
      const choices = options.map((option, index) => `${index + 1}) ${option}`).join('   ')
      print(
        `\n#${number} ${message.text}\n   ${choices}${allowText ? '   (or type a reply)' : ''}\n${formatAttachment(attachment)}`,
      )
      const reference: TerminalReference = { number, id }
      return Promise.resolve(reference)
    },
    finalize(
      reference: MessageReference,
      _message: FormattedText,
      ending: MessageEnding,
    ): Promise<void> {
      if (!isTerminalReference(reference)) {
        return Promise.resolve()
      }
      if (openQuestions.get(reference.number)?.id === reference.id) {
        openQuestions.delete(reference.number)
      }
      print(`#${reference.number} ${describeEnding(ending)}\n`)
      return Promise.resolve()
    },
    sendNotification(
      id: string,
      message: FormattedText,
      _options,
      attachment: Attachment | undefined,
    ): Promise<MessageReference> {
      print(`\nnotification: ${message.text}\n${formatAttachment(attachment)}`)
      return Promise.resolve({ id })
    },
    start(handlers: RuntimeHandlers): void {
      print(`${TERMINAL_INTRO}\n`)
      lines = createInterface({ input: io.input })
      lines.on('line', (line) => handleLine(handlers, line))
    },
    stop(): Promise<void> {
      lines?.close()
      return Promise.resolve()
    },
  }
}
