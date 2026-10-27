export const STATE_FILE_NAME = 'state.json'

export const SELECT_SQL = {
  requests: 'SELECT id, provider, record FROM requests WHERE bot_id = ? ORDER BY rowid',
  notifications: 'SELECT id, provider, record FROM notifications WHERE bot_id = ? ORDER BY rowid',
} as const

export const DELETE_OTHER_PROVIDER_SQL = {
  requests: 'DELETE FROM requests WHERE bot_id = ? AND provider <> ?',
  notifications: 'DELETE FROM notifications WHERE bot_id = ? AND provider <> ?',
} as const

export const DELETE_ROW_SQL = {
  requests: 'DELETE FROM requests WHERE bot_id = ? AND id = ?',
  notifications: 'DELETE FROM notifications WHERE bot_id = ? AND id = ?',
} as const

export const REPLACE_SQL = {
  requests: 'INSERT OR REPLACE INTO requests (bot_id, id, provider, record) VALUES (?, ?, ?, ?)',
  notifications:
    'INSERT OR REPLACE INTO notifications (bot_id, id, provider, record) VALUES (?, ?, ?, ?)',
} as const
