import type { Attachment, MessageReference } from '../approval/index.ts'
import type { FormattedText } from '../format/index.ts'
import type { NotificationRecord } from '../state/index.ts'

/** As produced by `parseNotifyRequest`. */
export type NotifyRequest = {
  readonly message: FormattedText
  /** The decoded file to send with the notification; `undefined` when the caller sent none. */
  readonly attachment: Attachment | undefined
}

/** Outcome of validating a /notify body; `error` is the client-facing message. */
export type NotifyParseResult =
  | { readonly ok: true; readonly value: NotifyRequest }
  | { readonly ok: false; readonly error: string }

/**
 * How a notification is delivered; `silent` suppresses the sound and vibration, `dismissible`
 * adds a Dismiss button (off when no process stays alive to handle the tap).
 */
export type SendNotificationOptions = {
  readonly silent: boolean
  readonly dismissible: boolean
}

/**
 * Optional messenger part for notifications. Without `deleteMessage` there's no dismiss button and
 * no expiry.
 */
export type Notifier = {
  /** Send `message` to the owner with a dismiss control carrying `id`, if the messenger can delete. */
  readonly sendNotification: (
    id: string,
    message: FormattedText,
    options: SendNotificationOptions,
    /** The file to send with the notification; `undefined` when there is none. */
    attachment: Attachment | undefined,
  ) => Promise<MessageReference>
  readonly deleteMessage?: (reference: MessageReference) => Promise<void>
}

/** Where live notifications are saved so a restart can still expire them; calls must not throw. */
export type NotificationStore = {
  readonly addNotification: (record: NotificationRecord) => void
  readonly removeNotification: (id: string) => void
}

/** Where quiet periods come from; `QuietService` satisfies it structurally. */
export type QuietSource = {
  /** When the current quiet period ends, or undefined when not quiet. */
  readonly quietUntil: () => Date | undefined
}

/**
 * Optional collaborators of `NotificationService`; `now` is the wall clock in epoch ms. Without
 * `quiet` it's never quiet.
 */
export type NotificationServiceOptions = {
  readonly quiet?: QuietSource
  readonly store?: NotificationStore
  readonly now?: () => number
}
