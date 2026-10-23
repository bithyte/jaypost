export const AUDIT_FILE_NAME = 'audit.jsonl'

export const ROTATED_SUFFIX = '.1'

export const MAX_AUDIT_LOG_BYTES = 10 * 1024 * 1024

export const AUDIT_FORMAT_VERSION = 1

export const DURATION_PATTERN = /^(\d+)([mhd])$/

export const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/

export const PROJECT_COLUMN_MAX = 20

export const QUESTION_COLUMN_MAX = 80

export const ANSWER_COLUMN_MAX = 30

// Matching control characters is the point: they are stripped before printing.
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g

/** Oldest service version that writes the audit log. */
export const MIN_AUDIT_VERSION = '0.5.0'

export const DEFAULT_LOG_LIMIT = 20
