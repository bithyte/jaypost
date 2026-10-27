import type { NotificationRecord, RequestRecord } from '@jaypost/core'

export type SavedState = {
  readonly requests: readonly RequestRecord[]
  readonly notifications: readonly NotificationRecord[]
}
