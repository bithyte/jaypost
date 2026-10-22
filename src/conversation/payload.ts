import { appendText } from '../format/index.ts'
import type { FormattedText } from '../format/index.ts'
import {
  CHOICE_PAYLOAD_PATTERN,
  DISMISS_PAYLOAD_PATTERN,
  TEXT_HINT_WITHOUT_BUTTONS,
  TEXT_HINT_WITH_BUTTONS,
} from './constants.ts'

/** Button payload `<id>:<optionIndex>`; fits Telegram's 64 byte limit with a uuid. */
export function formatChoicePayload(id: string, optionIndex: number): string {
  return `${id}:${optionIndex}`
}

/** Button payload `dismiss/<id>`; never parses as a choice. */
export function formatDismissPayload(id: string): string {
  return `dismiss/${id}`
}

/** Appends the reply hint when `allowText`; which hint depends on `hasButtons`. */
export function withTextHint(
  message: FormattedText,
  hasButtons: boolean,
  allowText: boolean,
): FormattedText {
  if (!allowText) {
    return message
  }
  const hint = hasButtons ? TEXT_HINT_WITH_BUTTONS : TEXT_HINT_WITHOUT_BUTTONS
  return appendText(message, `\n\n${hint}`)
}

export function parseChoicePayload(
  payload: string | undefined,
): { readonly id: string; readonly optionIndex: number } | undefined {
  const match = payload === undefined ? null : CHOICE_PAYLOAD_PATTERN.exec(payload)
  const id = match?.[1]
  const rawIndex = match?.[2]
  if (id === undefined || rawIndex === undefined) {
    return undefined
  }
  return { id, optionIndex: Number(rawIndex) }
}

export function parseDismissPayload(payload: string | undefined): string | undefined {
  const match = payload === undefined ? null : DISMISS_PAYLOAD_PATTERN.exec(payload)
  return match?.[1]
}
