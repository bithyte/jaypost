/** Longest message `content` Discord accepts. */
export const DISCORD_MAX_CONTENT_LENGTH = 2000
/** Characters Discord reads as markup; each gets a backslash wherever it appears. */
export const MARKUP_CHARACTERS = '\\*_~`|<[#>'
/** Invisible character that keeps two backticks in code from closing it. */
export const ZERO_WIDTH_SPACE = '\u200b'
/** A bare link; Discord's autolink eats backslashes, so nothing inside one is escaped. */
export const URL_PATTERN = /https?:\/\/[^\s<]+/g
/** A backtick followed by another backtick, which would close code early. */
export const DOUBLE_BACKTICK_PATTERN = /`(?=`)/g
/** A single whitespace character. */
export const WHITESPACE_PATTERN = /^\s$/
/** Spaces then digits: what precedes the `.` of a numbered list marker. */
export const NUMBER_PREFIX_PATTERN = /^ *\d+$/
/** Only spaces: what precedes a `-` or `+` list marker. */
export const SPACES_PATTERN = /^ *$/
