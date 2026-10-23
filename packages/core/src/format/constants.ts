import type { MessageFormat } from './types.ts'

export const MESSAGE_FORMATS = ['plain', 'markdown'] as const

export const DEFAULT_FORMAT: MessageFormat = 'plain'

/** A fenced block's language is kept only when its first info word looks like this. */
export const LANGUAGE_PATTERN = /^[A-Za-z0-9_+#.-]{1,32}$/

/** CommonMark's ASCII punctuation: a backslash before one of these is an escape. */
export const ESCAPABLE_CHARACTERS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

/** Emphasis nested deeper than this stays literal, which bounds recursion and work. */
export const MAX_EMPHASIS_DEPTH = 8

/** A quote hugging a marker means a quoted glob like `'*'`, not emphasis. */
export const QUOTE_CHARACTERS = '"\''

/** May sit between whitespace and an opening emphasis marker. */
export const OPENER_PREFIX_CHARACTERS = '([{"\''

/** May sit between a closing emphasis marker and whitespace or the end. */
export const CLOSER_SUFFIX_CHARACTERS = '.,:;!?)]}"\''

export const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/

export const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/

export const HEADING_PATTERN = /^ {0,3}#{1,6}[ \t]+(.*)$/

export const HEADING_CLOSING_PATTERN = /(?:^|[ \t]+)#+[ \t]*$/

export const BLOCKQUOTE_PATTERN = /^ {0,3}> ?(.*)$/
