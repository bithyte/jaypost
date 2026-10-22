import type { SendNotificationOptions } from '../notify/index.ts'
import type { SendMode } from './types.ts'

export const SERVICE_MODE = { kind: 'service' } as const satisfies SendMode
export const DIRECT_MODE = { kind: 'direct' } as const satisfies SendMode

/** No dismiss button: no process stays alive to handle the tap or expire the message. */
export const DIRECT_NOTIFICATION_OPTIONS = {
  silent: false,
  dismissible: false,
} as const satisfies SendNotificationOptions
