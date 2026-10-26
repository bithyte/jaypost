import type { SendNotificationOptions } from '@jaypost/core'
import type { ApproverList, SendMode } from './types.ts'

export const SERVICE_MODE = { kind: 'service' } as const satisfies SendMode
export const DIRECT_MODE = { kind: 'direct' } as const satisfies SendMode
export const NO_APPROVERS = { kind: 'none' } as const satisfies ApproverList
export const EMPTY_APPROVERS = { kind: 'empty' } as const satisfies ApproverList

/** Splits the approver env value on commas and whitespace. */
export const APPROVER_SEPARATOR_PATTERN = /[\s,]+/

/** No dismiss button: no process stays alive to handle the tap or expire the message. */
export const DIRECT_NOTIFICATION_OPTIONS = {
  silent: false,
  dismissible: false,
} as const satisfies Omit<SendNotificationOptions, 'recipient'>
