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
/** Matches `<id>:<optionIndex>`, the format `formatCustomId` writes; no `/`, so never a dismiss. */
export const CUSTOM_ID_PATTERN = /^([^:/]+):(\d+)$/
/** Matches `dismiss/<id>`, the format `formatDismissId` writes; no `:`, so never an approval tap. */
export const DISMISS_ID_PATTERN = /^dismiss\/([^:]+)$/
/** Label of the button that deletes a notification. */
export const DISMISS_LABEL = 'Dismiss'
/** Most buttons Discord allows in one action row. */
export const BUTTONS_PER_ROW = 5
/** Most options a request can show as buttons (five rows of five). */
export const DISCORD_MAX_OPTION_COUNT = 25
/** Hint appended to a text-enabled request that has buttons. */
export const TEXT_HINT_WITH_BUTTONS = 'Tap a button or reply to this message to type an answer.'
/** Hint appended to a text-enabled request without buttons. */
export const TEXT_HINT_WITHOUT_BUTTONS = 'Reply to this message with your answer.'
/** Bot answer to a typed reply on a question that only takes buttons. */
export const BUTTONS_ONLY_REPLY = 'Tap one of the buttons to answer this question.'
/** Bot answer to a reply on a message that isn't an open question (or has expired). */
export const NOT_OPEN_REPLY = "That message isn't waiting for an answer."
/** Bot answer to a plain message while several text questions are open. */
export const AMBIGUOUS_REPLY = "Several questions are open; reply to the one you're answering."
/** Bot answer to a non-text reply on an open text question. */
export const NOT_TEXT_REPLY = 'Only text replies count as an answer.'
/** Bot answer to a correct pairing code. */
export const PAIRED_REPLY = 'Paired. Approval requests will appear here.'
/** Bot answer to a wrong pairing code. */
export const WRONG_CODE_REPLY =
  "This bot isn't paired. Check the service logs for the pairing code."
/** Ephemeral answer to a tap on a request that is no longer valid. */
export const EXPIRED_REPLY = 'Expired'
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
