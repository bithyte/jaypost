/** The line written when a request is sent. */
export type AskedRecord = {
  readonly v: number
  readonly event: 'asked'
  readonly id: string
  readonly at: string
  readonly project?: string
  readonly text: string
  readonly options: readonly string[]
  readonly timeoutOption: string
  readonly timeoutSeconds: number
  /** The asking API key and its contact; omitted for a request without a caller. */
  readonly key?: string
  readonly contact?: string
}

/** The line written when a request ends; `outcome` is the settlement kind. */
export type SettledRecord = {
  readonly v: number
  readonly event: 'settled'
  readonly id: string
  readonly at: string
  readonly outcome: string
  readonly answer?: string
  /** The asking API key and its contact; omitted for a request without a caller. */
  readonly key?: string
  readonly contact?: string
}

export type AuditLogOptions = {
  readonly log?: (line: string) => void
}

/** One question as `log --json` prints it; key order is the output order. */
export type AuditEntry = {
  readonly id: string
  readonly askedAt: string
  readonly project?: string
  readonly text: string
  readonly options: readonly string[]
  readonly timeoutOption: string
  readonly timeoutSeconds: number
  /** Settled outcome (open set), or `pending` / `interrupted` when no settled line exists. */
  readonly status: string
  readonly answer?: string
  readonly settledAt?: string
  /** From the asked line; omitted for a question asked without a key (or before keys existed). */
  readonly key?: string
  readonly contact?: string
  /** Set by readers that merge several bots' logs; never by `parseAuditLog`. */
  readonly bot?: string
}

export type AuditReadResult = {
  readonly entries: readonly AuditEntry[]
  readonly skippedCount: number
}

export type AuditFilter = {
  readonly since?: Date
  readonly project?: string
  readonly limit?: number
  readonly key?: string
  readonly contact?: string
  readonly bot?: string
}

/** One question with the bot that asked it. */
export type BotAuditEntry = {
  readonly botId: string
  readonly entry: AuditEntry
}
