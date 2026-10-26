/** Matches `<id>:<optionIndex>`, the format `formatChoicePayload` writes; no `/`, so never a dismiss. */
export const CHOICE_PAYLOAD_PATTERN = /^([^:/]+):(\d+)$/
/** Matches `dismiss/<id>`, the format `formatDismissPayload` writes; no `:`, so never a choice. */
export const DISMISS_PAYLOAD_PATTERN = /^dismiss\/([^:]+)$/
/** Leading `/start` or `/start@botname` on a pairing message. */
export const START_COMMAND_PATTERN = /^\/start(@\w+)?/i
/** Label of the button that deletes a notification. */
export const DISMISS_LABEL = 'Dismiss'
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
export const WRONG_CODE_REPLY = "That pairing code didn't match. Check it and try again."
/** Answer to a tap on a request that is no longer valid. */
export const EXPIRED_REPLY = 'Expired'
