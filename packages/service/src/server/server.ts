import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  askWithRetries,
  parseApprovalRequest,
  parseNotifyRequest,
  parseRetryCount,
  parseVoteRequest,
  parseWaitSeconds,
  runVote,
  SendError,
  toVoteReport,
  VoterSendError,
} from '@jaypost/core'
import type { ApprovalRequest, RequestState, Vote } from '@jaypost/core'
import { UNAUTHORIZED_ERROR } from '@jaypost/store'
import {
  ATTACHMENTS_UNSUPPORTED_ERROR,
  MAX_BODY_BYTES,
  REQUEST_ID_PATH_PATTERN,
  UNKNOWN_REQUEST_ERROR,
} from './constants.ts'
import { formatOpenApiYaml } from './openapi.ts'
import type { ApiBot, BotRouter } from './types.ts'

/** HTTP body of a background question's state. */
function toStateBody(id: string, state: RequestState) {
  switch (state.kind) {
    case 'pending':
      return { id, state: 'pending', expiresAt: state.expiresAt.toISOString() }
    case 'done':
      return { id, state: 'done', answer: state.outcome.answer, timedOut: state.outcome.timedOut }
    case 'cancelled':
      return { id, state: 'cancelled' }
  }
}

function hasKey(json: unknown, key: string): boolean {
  return typeof json === 'object' && json !== null && Object.hasOwn(json, key)
}

/** Aborts once the client goes away before the reply is written. */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const controller = new AbortController()
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      controller.abort()
    }
  })
  // The client may have gone while the body was being read, before 'close' was observed.
  if (reply.raw.destroyed) {
    controller.abort()
  }
  return controller.signal
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/** A /request body: the question and its re-asks, if any. */
function parseAsk(
  bot: ApiBot,
  json: unknown,
): Parsed<{ readonly request: ApprovalRequest; readonly retryCount: number | undefined }> {
  const parsed = parseApprovalRequest(
    json,
    bot.maxTextLength,
    bot.maxAttachmentBytes ?? 0,
    bot.maxOptionCount,
  )
  if (!parsed.ok) {
    return parsed
  }
  const retry = parseRetryCount(json)
  if (!retry.ok) {
    return retry
  }
  return { ok: true, value: { request: parsed.value, retryCount: retry.retryCount } }
}

/** A /request/async body; `retry` is refused, since nothing would re-ask a background question. */
function parseBackgroundAsk(bot: ApiBot, json: unknown): Parsed<ApprovalRequest> {
  const parsed = parseApprovalRequest(
    json,
    bot.maxTextLength,
    bot.maxAttachmentBytes ?? 0,
    bot.maxOptionCount,
  )
  if (parsed.ok && hasKey(json, 'retry')) {
    return { ok: false, error: "retry isn't supported on /request/async" }
  }
  return parsed
}

/** A /vote body with its voters resolved by the bot's provider. */
function parseVote(bot: ApiBot, json: unknown): Parsed<Vote> {
  const parsed = parseVoteRequest(
    json,
    bot.maxTextLength,
    bot.maxAttachmentBytes ?? 0,
    bot.maxOptionCount,
  )
  if (!parsed.ok) {
    return parsed
  }
  const { request, voters, rule, retryCount } = parsed.value
  const resolved = bot.resolveVoters(voters)
  switch (resolved.kind) {
    case 'invalid':
      return { ok: false, error: `invalid user id ${JSON.stringify(resolved.voter)}` }
    case 'noOwner':
      return { ok: false, error: 'voters is required, since this provider has no owner' }
    case 'voters':
      return { ok: true, value: { request, voters: resolved.voters, rule, retryCount } }
  }
}

/**
 * Builds the HTTP API (POST /request, POST /request/async, GET and DELETE /request/:id,
 * POST /vote, POST /notify, GET /status, GET /openapi.yaml) without listening. Every route but
 * /openapi.yaml asks `router` for the call's bot first and answers 401 when there is none, before
 * parsing the body. Aborting the connection cancels a pending /request or /vote; background
 * questions outlive their connections. Errors return JSON bodies. A bot without notifications
 * answers POST /notify 501.
 */
export function createApiServer(router: BotRouter): FastifyInstance {
  const botsByRequest = new WeakMap<FastifyRequest, ApiBot>()
  // Only reached after the guard routed the call.
  const requireBot = (request: FastifyRequest): ApiBot => {
    const bot = botsByRequest.get(request)
    if (bot === undefined) {
      throw new Error(`no bot routed for ${request.url}`)
    }
    return bot
  }
  // Pending requests can hang for minutes; close() shouldn't wait for them.
  // A question can hold its response for up to 24 h; these timeouts must never cap it.
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    forceCloseConnections: true,
    requestTimeout: 0,
    connectionTimeout: 0,
  })
  // Take the body as text whatever the content type, so bad JSON gets our own 400.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body))
  app.setNotFoundHandler((request, reply) => {
    // Not new URL(): it throws on targets like '//'.
    const path = request.url.split('?')[0]
    if (
      path === '/request' ||
      path === '/request/async' ||
      path === '/vote' ||
      path === '/notify'
    ) {
      return reply.code(405).header('Allow', 'POST').send({ error: 'method not allowed' })
    }
    if (path !== undefined && REQUEST_ID_PATH_PATTERN.test(path)) {
      return reply.code(405).header('Allow', 'GET, DELETE').send({ error: 'method not allowed' })
    }
    if (path === '/status' || path === '/openapi.yaml') {
      return reply.code(405).header('Allow', 'GET').send({ error: 'method not allowed' })
    }
    return reply.code(404).send({ error: 'not found' })
  })
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof VoterSendError) {
      // Names only the voter, never the cause.
      console.error(`${error.message} via ${botsByRequest.get(request)?.providerName ?? 'unknown'}`)
      return reply.code(502).send({ error: 'failed to send message', voter: error.voter })
    }
    if (error instanceof SendError) {
      // Log the message only; the cause can hold provider internals.
      console.error(`${error.message} via ${botsByRequest.get(request)?.providerName ?? 'unknown'}`)
      return reply.code(502).send({ error: 'failed to send message' })
    }
    if (error.statusCode === 413) {
      // Drop the rest of the upload once the response is flushed.
      reply.raw.once('finish', () => request.raw.destroy())
      return reply.code(413).header('Connection', 'close').send({ error: 'request body too large' })
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message })
    }
    console.error(`unexpected error handling ${request.url}`, error)
    return reply.code(500).send({ error: 'internal server error' })
  })
  const guard = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      const route = router.route(request.headers.authorization)
      if (route.kind === 'bot') {
        botsByRequest.set(request, route.bot)
        return
      }
      console.error(
        `rejected ${request.method} ${request.url.split('?')[0]}: ${route.reason} token`,
      )
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: UNAUTHORIZED_ERROR })
    },
  }
  app.get('/status', guard, async (request) => {
    const bot = requireBot(request)
    return {
      ...bot.status(),
      maxAttachmentBytes: bot.maxAttachmentBytes ?? 0,
      maxTextLength: bot.maxTextLength,
      ...(bot.maxOptionCount === undefined ? {} : { maxOptionCount: bot.maxOptionCount }),
    }
  })
  // Containers publish the same port on the host, so the local port is the one clients use.
  app.get('/openapi.yaml', async (request, reply) =>
    reply
      .type('application/yaml; charset=utf-8')
      .send(formatOpenApiYaml({ port: request.socket.localPort ?? 0, ...router.limits })),
  )
  // Replies 503/400/501 itself and returns undefined, or returns what `parse` made of the body.
  // Drops the raw body from the Fastify request so a long wait doesn't keep an attachment's bytes
  // alive; the parsed JSON goes out of scope on return for the same reason.
  const readBody = <T>(
    bot: ApiBot,
    request: FastifyRequest<{ Body: string | undefined }>,
    reply: FastifyReply,
    parse: (bot: ApiBot, json: unknown) => Parsed<T>,
  ): T | undefined => {
    const body = request.body
    request.body = undefined
    if (!bot.status().paired) {
      reply.code(503).send({ error: 'not paired' })
      return undefined
    }
    let json: unknown
    try {
      json = JSON.parse(body ?? '')
    } catch {
      reply.code(400).send({ error: 'body must be valid JSON' })
      return undefined
    }
    if ((bot.maxAttachmentBytes ?? 0) === 0 && hasKey(json, 'attachment')) {
      reply.code(501).send({ error: ATTACHMENTS_UNSUPPORTED_ERROR })
      return undefined
    }
    const parsed = parse(bot, json)
    if (!parsed.ok) {
      reply.code(400).send({ error: parsed.error })
      return undefined
    }
    return parsed.value
  }
  app.post<{ Body: string | undefined }>('/request', guard, async (request, reply) => {
    const bot = requireBot(request)
    let ask = readBody(bot, request, reply, parseAsk)
    if (ask === undefined) {
      return reply
    }
    const signal = abortOnClose(reply)
    const { retryCount } = ask
    const pending = askWithRetries(bot.service, ask.request, retryCount ?? 0, signal)
    // V8 keeps locals alive across await; drop the only handle on the attachment bytes first.
    ask = undefined
    const result = await pending
    if (result.kind === 'cancelled') {
      // Normally because the client is gone, so this write is a no-op.
      return reply.code(500).send({ error: 'request was cancelled' })
    }
    // `rounds` tells a client that sent `retry` that this service re-asks.
    return retryCount === undefined
      ? result.outcome
      : { ...result.outcome, rounds: result.roundCount }
  })
  app.post<{ Body: string | undefined }>('/request/async', guard, async (request, reply) => {
    const bot = requireBot(request)
    const approval = readBody(bot, request, reply, parseBackgroundAsk)
    if (approval === undefined) {
      return reply
    }
    const { id, expiresAt } = await bot.service.start(approval)
    return reply
      .code(202)
      .header('Location', `/request/${id}`)
      .send(toStateBody(id, { kind: 'pending', expiresAt }))
  })
  app.post<{ Body: string | undefined }>('/vote', guard, async (request, reply) => {
    const bot = requireBot(request)
    let vote = readBody(bot, request, reply, parseVote)
    if (vote === undefined) {
      return reply
    }
    const { rule } = vote
    const pending = runVote(bot.service, vote, abortOnClose(reply))
    vote = undefined
    const result = await pending
    if (result.kind === 'cancelled') {
      return reply.code(500).send({ error: 'request was cancelled' })
    }
    return toVoteReport(result, rule)
  })
  app.get<{ Params: { id: string }; Querystring: { wait?: unknown } }>(
    '/request/:id',
    guard,
    async (request, reply) => {
      const { service } = requireBot(request)
      const { id } = request.params
      const wait = parseWaitSeconds(request.query.wait)
      if (!wait.ok) {
        return reply.code(400).send({ error: wait.error })
      }
      let state: RequestState | undefined
      if (wait.seconds === 0) {
        state = service.get(id)
      } else {
        // Only stops this wait; the question stays open when the poller goes away.
        state = await service.waitFor(id, wait.seconds * 1000, abortOnClose(reply))
      }
      if (state === undefined) {
        return reply.code(404).send({ error: UNKNOWN_REQUEST_ERROR })
      }
      return toStateBody(id, state)
    },
  )
  app.delete<{ Params: { id: string } }>('/request/:id', guard, async (request, reply) => {
    const { service } = requireBot(request)
    const { id } = request.params
    const state = await service.cancel(id)
    if (state === undefined) {
      return reply.code(404).send({ error: UNKNOWN_REQUEST_ERROR })
    }
    return toStateBody(id, state)
  })
  app.post<{ Body: string | undefined }>('/notify', guard, async (request, reply) => {
    const bot = requireBot(request)
    const { notifications } = bot
    if (notifications === undefined) {
      return reply.code(501).send({ error: 'notifications not supported' })
    }
    if (!bot.status().paired) {
      return reply.code(503).send({ error: 'not paired' })
    }
    const body = request.body
    request.body = undefined
    let json: unknown
    try {
      json = JSON.parse(body ?? '')
    } catch {
      return reply.code(400).send({ error: 'body must be valid JSON' })
    }
    const attachmentLimit = bot.maxAttachmentBytes ?? 0
    if (attachmentLimit === 0 && hasKey(json, 'attachment')) {
      return reply.code(501).send({ error: ATTACHMENTS_UNSUPPORTED_ERROR })
    }
    const parsed = parseNotifyRequest(json, bot.maxTextLength, attachmentLimit)
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error })
    }
    await notifications.notify(parsed.value)
    return { ok: true }
  })
  return app
}
