import { expect, test } from 'vite-plus/test'
import {
  DISMISS_LABEL,
  TEXT_HINT_WITHOUT_BUTTONS,
  TEXT_HINT_WITH_BUTTONS,
  formatChoicePayload,
  formatDismissPayload,
  withTextHint,
} from '../../src/conversation/index.ts'

const plain = (text: string) => ({ text, spans: [] })
const BOLD = { kind: 'bold', offset: 0, length: 1 } as const

test('formatChoicePayload writes <id>:<optionIndex>', () => {
  expect(formatChoicePayload('abc', 1)).toBe('abc:1')
})

test('formatDismissPayload writes dismiss/<id>', () => {
  expect(formatDismissPayload('abc')).toBe('dismiss/abc')
})

test('payloads fit telegram callback data with a uuid', () => {
  const id = crypto.randomUUID()
  expect(Buffer.byteLength(formatChoicePayload(id, 24))).toBeLessThanOrEqual(64)
  expect(Buffer.byteLength(formatDismissPayload(id))).toBeLessThanOrEqual(64)
})

test('withTextHint appends the buttons hint and keeps spans', () => {
  expect(withTextHint({ text: 'Q', spans: [BOLD] }, true, true)).toEqual({
    text: `Q\n\n${TEXT_HINT_WITH_BUTTONS}`,
    spans: [BOLD],
  })
})

test('withTextHint appends the reply hint without buttons', () => {
  expect(withTextHint(plain('Q'), false, true)).toEqual(plain(`Q\n\n${TEXT_HINT_WITHOUT_BUTTONS}`))
})

test.each([true, false])(
  'withTextHint leaves the message alone without text (buttons %s)',
  (hasButtons) => {
    expect(withTextHint(plain('Q'), hasButtons, false)).toEqual(plain('Q'))
  },
)

test('copy strings are pinned', () => {
  expect(TEXT_HINT_WITH_BUTTONS).toBe('Tap a button or reply to this message to type an answer.')
  expect(TEXT_HINT_WITHOUT_BUTTONS).toBe('Reply to this message with your answer.')
  expect(DISMISS_LABEL).toBe('Dismiss')
})
