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
}

/** The line written when a request ends; `outcome` is the settlement kind. */
export type SettledRecord = {
  readonly v: number
  readonly event: 'settled'
  readonly id: string
  readonly at: string
  readonly outcome: string
  readonly answer?: string
}

export type AuditLogOptions = {
  readonly maxBytes?: number
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
}

export type AuditReadResult = {
  readonly entries: readonly AuditEntry[]
  readonly skippedCount: number
}

export type AuditFilter = {
  readonly since?: Date
  readonly project?: string
  readonly limit?: number
}
