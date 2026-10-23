export const DONE_SYMBOL = '◇'

export const FAIL_SYMBOL = '■'

export const CANCEL_SYMBOL = '◆'

export const PENDING_SYMBOL = '○'

/** Prefix of tail, detail and failure output lines. */
export const RAIL = '│  '

export const SPINNER_FRAMES: readonly string[] = ['◒', '◐', '◓', '◑']

/** Output lines shown under the running step. */
export const TAIL_LINE_COUNT = 4

export const FRAME_INTERVAL_MS = 120

/** Used when the stream reports no width. */
export const DEFAULT_COLUMNS = 80

export const HIDE_CURSOR = '\x1b[?25l'

export const SHOW_CURSOR = '\x1b[?25h'

export const CLEAR_TO_END = '\x1b[0J'

/** CSI sequences such as colors and cursor moves, stripped from subprocess output. */
// eslint-disable-next-line no-control-regex
export const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** An escape sequence cut off at the end of a chunk. */
// eslint-disable-next-line no-control-regex
export const PARTIAL_ANSI_PATTERN = /\x1b(\[[0-9;?]*[ -/]*)?$/
