import { z } from 'zod'
import { DEFAULT_FORMAT, toFormattedText } from '../format/index.ts'
import {
  BLANK_FORMATTED_ERROR,
  checkProjectText,
  createAttachmentSchema,
  createFormatSchema,
  createProjectSchema,
  createTextSchema,
} from '../approval/index.ts'
import {
  DELETE_AFTER_ERROR,
  DELETE_AFTER_PAST_ERROR,
  SECONDS_PATTERN,
  TIMESTAMP_PATTERN,
} from './constants.ts'
import type { DeleteAfter, NotifyParseResult } from './types.ts'

/** Schema of a /notify body; also the source of the OpenAPI spec. */
export function createNotifyRequestSchema(maxTextLength: number, maxAttachmentBytes: number) {
  return z
    .object(
      {
        text: createTextSchema(),
        project: createProjectSchema(),
        format: createFormatSchema(),
        attachment: createAttachmentSchema(maxAttachmentBytes).optional(),
        deleteAfter: z.union([z.number(), z.string()], { error: DELETE_AFTER_ERROR }).optional(),
      },
      { error: 'body must be a JSON object' },
    )
    .transform(({ text, project, format, attachment, deleteAfter: rawDeleteAfter }, context) => {
      const message = toFormattedText(text, format ?? DEFAULT_FORMAT)
      if (message.text.trim() === '') {
        context.addIssue({ code: 'custom', message: BLANK_FORMATTED_ERROR })
        return z.NEVER
      }
      const checked = checkProjectText(message, project, maxTextLength, format ?? DEFAULT_FORMAT)
      if (!checked.ok) {
        context.addIssue({ code: 'custom', message: checked.error })
        return z.NEVER
      }
      const deleteAfter = toDeleteAfter(rawDeleteAfter)
      if (deleteAfter === 'invalid') {
        context.addIssue({ code: 'custom', message: DELETE_AFTER_ERROR })
        return z.NEVER
      }
      return { message: checked.message, attachment, deleteAfter }
    })
}

/** Validates a /notify body against `nowMs`; never throws. Returns the first problem as `error`. */
export function parseNotifyRequest(
  body: unknown,
  maxTextLength: number,
  maxAttachmentBytes: number,
  nowMs: number = Date.now(),
): NotifyParseResult {
  const result = createNotifyRequestSchema(maxTextLength, maxAttachmentBytes).safeParse(body)
  if (result.success) {
    const { deleteAfter } = result.data
    if (deleteAfter?.kind === 'timestamp' && deleteAfter.atMs <= nowMs) {
      return { ok: false, error: DELETE_AFTER_PAST_ERROR }
    }
    return { ok: true, value: result.data }
  }
  return { ok: false, error: result.error.issues[0]?.message ?? 'invalid request' }
}

function toDeleteAfter(raw: number | string | undefined): DeleteAfter | undefined | 'invalid' {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw === 'number' || SECONDS_PATTERN.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds > 0 ? { kind: 'seconds', seconds } : 'invalid'
  }
  const atMs = TIMESTAMP_PATTERN.test(raw) ? Date.parse(raw) : Number.NaN
  return Number.isNaN(atMs) ? 'invalid' : { kind: 'timestamp', atMs }
}
