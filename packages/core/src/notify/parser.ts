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
import type { NotifyParseResult } from './types.ts'

/** Schema of a /notify body; also the source of the OpenAPI spec. */
export function createNotifyRequestSchema(maxTextLength: number, maxAttachmentBytes: number) {
  return z
    .object(
      {
        text: createTextSchema(),
        project: createProjectSchema(),
        format: createFormatSchema(),
        attachment: createAttachmentSchema(maxAttachmentBytes).optional(),
      },
      { error: 'body must be a JSON object' },
    )
    .transform(({ text, project, format, attachment }, context) => {
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
      return { message: checked.message, attachment }
    })
}

/** Validates a /notify body; never throws. Returns the first problem as `error`. */
export function parseNotifyRequest(
  body: unknown,
  maxTextLength: number,
  maxAttachmentBytes: number,
): NotifyParseResult {
  const result = createNotifyRequestSchema(maxTextLength, maxAttachmentBytes).safeParse(body)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: result.error.issues[0]?.message ?? 'invalid request' }
}
