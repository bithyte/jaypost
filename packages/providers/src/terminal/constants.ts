/** Shown once at start. */
export const TERMINAL_INTRO =
  'Questions show up here: type an option number or a reply, "#2 1" when several are open, or /pending and the other commands.'
/** A `#<number>` prefix that picks one of several open questions. */
export const QUESTION_PREFIX_PATTERN = /^#(\d+)\s*(.*)$/
/** A whole line that is just an option number. */
export const OPTION_NUMBER_PATTERN = /^\d+$/
/** Long enough for any request the API accepts. */
export const TERMINAL_MAX_TEXT_LENGTH = 4096
