import type { OwnerCommand } from '../approval/index.ts'
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
/** Most buttons Discord allows in one action row. */
export const BUTTONS_PER_ROW = 5
/** Most options a request can show as buttons (five rows of five). */
export const DISCORD_MAX_OPTION_COUNT = 25
/** Answer to a slash command from anyone but the owner. */
export const NOT_OWNER_COMMAND_REPLY = "This bot isn't paired with you."
/** Ephemeral answer to an owner command that has no reply text. */
export const UNKNOWN_COMMAND_REPLY = 'Unknown command.'
/** The one optional argument of each command that takes one. */
export const COMMAND_OPTIONS: Readonly<
  Partial<Record<OwnerCommand['name'], { readonly name: string; readonly description: string }>>
> = {
  history: { name: 'count', description: 'How many answers to show (1-20)' },
  mute: { name: 'duration', description: 'How long, like 30m, 2h or 1d' },
  quiet: { name: 'hours', description: 'Quiet hours like 22-7, or off' },
}
/** How long `validateToken` waits for Discord before giving up. */
export const TOKEN_CHECK_TIMEOUT_MS = 10_000
/** Discord's REST API root; the client appends the version. */
export const DISCORD_API_ROOT = 'https://discord.com/api'
/** Gateway close codes that won't recover on retry: bad token, shard, version or intents. */
export const FATAL_CLOSE_CODES: readonly number[] = [4004, 4010, 4011, 4012, 4013, 4014]
/** Message flag that hides link previews. */
export const MESSAGE_FLAG_SUPPRESS_EMBEDS = 4
/** Message flag that delivers without a push notification. */
export const MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS = 4096
/** Message flag that shows an interaction reply only to the user who triggered it. */
export const MESSAGE_FLAG_EPHEMERAL = 64
/** Fatal message for a token Discord refuses; never includes the token. */
export const REJECTED_TOKEN_FATAL = 'Discord rejected the bot token; check it with `jaypost init`'
/** Most characters of request text; leaves room for the hint and escaping under Discord's limit. */
export const DISCORD_MAX_TEXT_LENGTH = 1800
/** Largest attachment Discord accepts on a default-tier message. */
export const DISCORD_MAX_ATTACHMENT_BYTES = 10_485_760
/** A Discord user id: a snowflake of 17 to 20 digits. */
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/
