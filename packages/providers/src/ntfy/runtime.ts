import type {
  Attachment,
  CredentialCheck,
  FormattedText,
  MessageReference,
  ProviderRuntime,
  RuntimeHandlers,
  SendNotificationOptions,
  SettingValues,
} from '@jaypost/core'
import {
  DISMISS_LABEL,
  formatChoicePayload,
  formatDismissPayload,
  NOT_OPEN_REPLY,
  OwnerConversation,
} from '@jaypost/core'
import { createNtfyClient } from './client.ts'
import {
  AMBIGUOUS_TEXT_REPLY,
  DEFAULT_NTFY_SERVER,
  FINAL_PRIORITY,
  MIN_OPEN_TOPIC_LENGTH,
  NO_TEXT_QUESTION_REPLY,
  NOTIFICATION_PRIORITY,
  NTFY_OWNER_ID,
  QUIET_PRIORITY,
  REPLY_TOPIC_SUFFIX,
  REQUEST_PRIORITY,
  TAP_TITLE,
} from './constants.ts'
import { parseServer, parseTopic } from './settings.ts'
import type {
  NtfyAction,
  NtfyClient,
  NtfyConnection,
  NtfyIncoming,
  NtfyMessageReference,
} from './types.ts'

/** The server, topic and token in `settings`, with the default server when none is set. */
export function toConnection(settings: SettingValues): NtfyConnection & { readonly topic: string } {
  return {
    server: typeof settings.ntfyServer === 'string' ? settings.ntfyServer : DEFAULT_NTFY_SERVER,
    topic: String(settings.ntfyTopic),
    token: typeof settings.ntfyToken === 'string' ? settings.ntfyToken : undefined,
  }
}

/** The hint appended to a question that takes a typed answer. */
export function formatTextHint(replyTopic: string, hasButtons: boolean): string {
  const how = `publish it to the topic ${replyTopic}`
  return hasButtons ? `Tap a button, or to type an answer ${how}.` : `To answer, ${how}.`
}

/**
 * Whether the topic and its reply topic can be used: a valid server and topic, both reachable and
 * allowed, and the topic long enough to be a secret when there's no token. Settings typed at
 * `init` arrive unparsed, hence the checks. The reason never contains the topic or token.
 */
export async function checkNtfyAccess(
  settings: SettingValues,
  client?: NtfyClient,
): Promise<CredentialCheck> {
  const { server, topic, token } = toConnection(settings)
  if (parseServer(server) !== server) {
    return { ok: false, reason: 'the ntfy server must be an http or https URL' }
  }
  if (parseTopic(topic) !== topic) {
    return {
      ok: false,
      reason: 'the ntfy topic must be 1 to 56 letters, digits, dashes or underscores',
    }
  }
  if (token === undefined && topic.length < MIN_OPEN_TOPIC_LENGTH) {
    return {
      ok: false,
      reason: `without an access token the ntfy topic must be at least ${MIN_OPEN_TOPIC_LENGTH} characters, since anyone who knows it can answer`,
    }
  }
  const checker = client ?? createNtfyClient({ server, token })
  for (const checked of [topic, `${topic}${REPLY_TOPIC_SUFFIX}`]) {
    const access = await checker.checkAccess(checked)
    switch (access.kind) {
      case 'ok':
        break
      case 'rejected':
        return {
          ok: false,
          reason: `ntfy refused access to the topic (${access.status}); check it with \`jaypost init\``,
        }
      case 'unreachable':
        return { ok: false, reason: 'could not reach the ntfy server' }
    }
  }
  return { ok: true, displayName: new URL(server).host }
}

/**
 * ntfy behind the provider contract. Questions and notifications are published to the topic with
 * the request id as sequence id; buttons publish their payload to the reply topic, which the
 * runtime subscribes to, so the phone never needs to reach this machine. Anyone who can publish to
 * the reply topic is the owner, so there is no pairing. Typed answers and `/` commands are messages
 * published to the reply topic by hand. Finalizing replaces the question with its final text and
 * clears it. Never logs the topic or token.
 */
export function createNtfyRuntime(
  settings: SettingValues,
  log: (line: string) => void,
  client: NtfyClient = createNtfyClient(toConnection(settings)),
): ProviderRuntime {
  const { server, topic, token } = toConnection(settings)
  const replyTopic = `${topic}${REPLY_TOPIC_SUFFIX}`
  const conversation = new OwnerConversation(NTFY_OWNER_ID)
  let unsubscribe: (() => void) | undefined
  let stopped = false
  function toAction(label: string, payload: string): NtfyAction {
    return {
      action: 'http',
      label,
      url: `${server}/${replyTopic}`,
      method: 'POST',
      // Taps go only to this runtime's stream, so they skip Firebase; the title marks them as taps.
      headers: {
        'x-title': TAP_TITLE,
        'x-firebase': 'no',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: payload,
      clear: true,
    }
  }
  function say(text: string): void {
    client.publish({ topic, message: text, priority: QUIET_PRIORITY, actions: [] }).catch(() => {
      log('failed to send an ntfy reply')
    })
  }
  function runCommand(handlers: RuntimeHandlers, text: string): void {
    const [name = '', ...rest] = text.slice(1).split(/\s+/)
    if (!handlers.commands.some((command) => command.name === name)) {
      const names = handlers.commands.map((command) => `/${command.name}`).join(' ')
      say(`Unknown command; try ${names}`)
      return
    }
    const reply = handlers.command(name, rest.join(' ').trim())
    if (reply !== undefined) {
      say(reply)
    }
  }
  function receive(handlers: RuntimeHandlers, incoming: NtfyIncoming): void {
    if (incoming.title === TAP_TITLE) {
      const outcome = conversation.tap(
        { senderId: NTFY_OWNER_ID, isDirect: true, payload: incoming.message.trim() },
        handlers,
      )
      if (outcome.kind === 'expired') {
        say(NOT_OPEN_REPLY)
      }
      return
    }
    const text = incoming.message.trim()
    if (text.startsWith('/')) {
      runCommand(handlers, text)
      return
    }
    const outcome = conversation.receive(
      { senderId: NTFY_OWNER_ID, fromBot: false, isDirect: true, text, replyTo: undefined },
      handlers,
    )
    switch (outcome.kind) {
      case 'answered':
        return
      case 'refused':
        // Without a replied-to message the only refusal is several open text questions.
        say(AMBIGUOUS_TEXT_REPLY)
        return
      case 'paired':
      case 'wrongCode':
        say(outcome.text)
        return
      case 'ignored':
        say(NO_TEXT_QUESTION_REPLY)
        return
    }
  }
  return {
    checkCredentials: () => checkNtfyAccess(settings, client),
    async sendRequest(
      id: string,
      message: FormattedText,
      options: readonly string[],
      allowText: boolean,
      _attachment: Attachment | undefined,
      recipient: string | undefined,
    ): Promise<MessageReference> {
      if (recipient !== undefined) {
        throw new Error('ntfy only sends to its own topic, not to other voters')
      }
      const hasButtons = options.length > 0
      await client.publish({
        topic,
        sequenceId: id,
        message: allowText
          ? `${message.text}\n\n${formatTextHint(replyTopic, hasButtons)}`
          : message.text,
        priority: REQUEST_PRIORITY,
        actions: options.map((label, index) => toAction(label, formatChoicePayload(id, index))),
      })
      conversation.track(id, id, allowText)
      return { sequenceId: id } satisfies NtfyMessageReference
    },
    async finalize(reference: MessageReference, message: FormattedText): Promise<void> {
      const { sequenceId } = reference as NtfyMessageReference
      conversation.forget(sequenceId)
      await client.publish({
        topic,
        sequenceId,
        message: message.text,
        priority: FINAL_PRIORITY,
        actions: [],
      })
      await client.clear(topic, sequenceId)
    },
    async sendNotification(
      id: string,
      message: FormattedText,
      options: SendNotificationOptions,
    ): Promise<MessageReference> {
      await client.publish({
        topic,
        sequenceId: id,
        message: message.text,
        priority: options.silent ? QUIET_PRIORITY : NOTIFICATION_PRIORITY,
        actions: options.dismissible ? [toAction(DISMISS_LABEL, formatDismissPayload(id))] : [],
      })
      return { sequenceId: id } satisfies NtfyMessageReference
    },
    async deleteMessage(reference: MessageReference): Promise<void> {
      const { sequenceId } = reference as NtfyMessageReference
      await client.remove(topic, sequenceId)
    },
    start(handlers: RuntimeHandlers): void {
      unsubscribe = client.subscribe(replyTopic, {
        message: (incoming) => {
          try {
            receive(handlers, incoming)
          } catch (error) {
            // Never the error text: it could carry request details
            log(
              `ntfy reply handler failed: ${error instanceof Error ? error.name : 'unknown error'}`,
            )
          }
        },
        fatal: (message) => {
          if (!stopped) {
            handlers.fatal(message)
          }
        },
      })
      log(`listening for answers on ${new URL(server).host}`)
    },
    stop(): Promise<void> {
      stopped = true
      unsubscribe?.()
      return Promise.resolve()
    },
  }
}
