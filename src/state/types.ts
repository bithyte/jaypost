import type { RequestRecord } from '../approval/index.ts'
import type { NotificationRecord } from '../notify/index.ts'

export type SavedState = {
  readonly requests: readonly RequestRecord[]
  readonly notifications: readonly NotificationRecord[]
}

export type StateParseResult =
  | { readonly ok: true; readonly state: SavedState }
  | { readonly ok: false; readonly reason: string }
