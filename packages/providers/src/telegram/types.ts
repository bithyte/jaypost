/** What `MessageReference` holds for Telegram; cast back at the messenger's edge. */
export type TelegramMessageReference = {
  readonly chatId: number
  readonly messageId: number
  /** Absent in references saved before text replies (and on notifications); absent means true. */
  readonly hasButtons?: boolean
  /** The document sent above the message; absent without an attachment and in references saved before attachments. */
  readonly documentMessageId?: number
}
