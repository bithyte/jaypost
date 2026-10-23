import type { NotificationRecord, RequestRecord } from '@jaypost/core'

export type SavedState = {
  readonly requests: readonly RequestRecord[]
  readonly notifications: readonly NotificationRecord[]
}

export type StateParseResult =
  | { readonly ok: true; readonly state: SavedState }
  | { readonly ok: false; readonly reason: string }
