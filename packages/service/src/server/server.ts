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
import { LOCAL_PERSON, UNAUTHORIZED_ERROR } from '@jaypost/store'
import {
  ATTACHMENTS_UNSUPPORTED_ERROR,
  BOT_UNAVAILABLE_ERROR,
  GET_ONLY_PATHS,
  MAX_BODY_BYTES,
  NOT_PAIRED_ERROR,
  REQUEST_ID_PATH_PATTERN,
  UNKNOWN_REQUEST_ERROR,
} from './constants.ts'
import { registerAdminRoutes } from './admin.ts'
import { formatOpenApiYaml } from './openapi.ts'
import { parseLogQuery } from './query.ts'
import type { AdminApi, ApiBot, BotRouter, KeyRoute, Parsed } from './types.ts'

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

/** Who questions go to: the key's person, or nobody in particular on a provider that doesn't pair. */
function toRecipient(person: string | undefined): string | undefined {
  return person === LOCAL_PERSON ? undefined : person
}

/** The question from the caller's key, sent to its person. */
function addressTo(route: KeyRoute, request: ApprovalRequest): ApprovalRequest {
  const recipient = toRecipient(route.person)
  return { ...request, caller: route.caller, ...(recipient === undefined ? {} : { recipient }) }
}

/** A /request body: the question and its re-asks, if any. */
function parseAsk(
  bot: ApiBot,
  route: KeyRoute,
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
  return {
    ok: true,
    value: { request: addressTo(route, parsed.value), retryCount: retry.retryCount },
  }
}

/** A /request/async body; `retry` is refused, since nothing would re-ask a background question. */
function parseBackgroundAsk(bot: ApiBot, route: KeyRoute, json: unknown): Parsed<ApprovalRequest> {
  const parsed = parseApprovalRequest(
    json,
    bot.maxTextLength,
    bot.maxAttachmentBytes ?? 0,
    bot.maxOptionCount,
  )
  if (parsed.ok && hasKey(json, 'retry')) {
    return { ok: false, error: "retry isn't supported on /request/async" }
  }
  return parsed.ok ? { ok: true, value: addressTo(route, parsed.value) } : parsed
}

/** A /vote body with its voters resolved by the bot's provider; no voters means the key's person. */
function parseVote(bot: ApiBot, route: KeyRoute, json: unknown): Parsed<Vote> {
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
  const resolved = bot.resolveVoters(voters, toRecipient(route.person))
  switch (resolved.kind) {
    case 'invalid':
      return { ok: false, error: `invalid user id ${JSON.stringify(resolved.voter)}` }
    case 'noOwner':
      return { ok: false, error: 'voters is required, since this provider has no owner' }
    case 'voters':
      return {
        ok: true,
        value: {
          request: { ...request, caller: route.caller },
          voters: resolved.voters,
          rule,
          retryCount,
        },
      }
  }
}

/** How the 502 log line names the bot: `b2 (telegram)`. */
function describeBot(route: KeyRoute | undefined): string {
  const bot = route?.bot
  return bot === undefined ? 'unknown' : `${bot.botId} (${bot.providerName})`
}

/**
 * Builds the HTTP API (POST /request, POST /request/async, GET and DELETE /request/:id,
 * POST /vote, POST /notify, GET /status, GET /log, GET /openapi.yaml) without listening. Every
 * route but /openapi.yaml asks `router` for the call's key first and answers 401 when there is
 * none, before parsing the body; routes with a body ask again once it's read. A key whose bot
 * isn't running gets 503 `bot unavailable` and one whose pairing waits for its code 503
 * `not paired` on the question routes. Aborting the connection cancels a pending /request or
 * /vote; background questions outlive their connections and only their key reads or cancels them.
 * Errors return JSON bodies. A bot without notifications answers POST /notify 501. With `admin`,
 * the /admin routes are served too, behind the admin key only.
 */
export function createApiServer(router: BotRouter, admin?: AdminApi): FastifyInstance {
  const routesByRequest = new WeakMap<FastifyRequest, KeyRoute>()
  // Only reached after the guard routed the call.
  const requireRoute = (request: FastifyRequest): KeyRoute => {
    const route = routesByRequest.get(request)
    if (route === undefined) {
      throw new Error(`no key routed for ${request.url}`)
    }
    return route
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
    if (path !== undefined && GET_ONLY_PATHS.includes(path)) {
      return reply.code(405).header('Allow', 'GET').send({ error: 'method not allowed' })
    }
    return reply.code(404).send({ error: 'not found' })
  })
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof VoterSendError) {
      // Names only the voter, never the cause.
      console.error(`${error.message} via ${describeBot(routesByRequest.get(request))}`)
      return reply.code(502).send({ error: 'failed to send message', voter: error.voter })
    }
    if (error instanceof SendError) {
      // Log the message only; the cause can hold provider internals.
      console.error(`${error.message} via ${describeBot(routesByRequest.get(request))}`)
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
  // Routes the call and remembers its key, or replies 401 and returns undefined.
  const routeCall = (request: FastifyRequest, reply: FastifyReply): KeyRoute | undefined => {
    const route = router.route(request.headers.authorization)
    if (route.kind === 'key') {
      routesByRequest.set(request, route)
      return route
    }
    console.error(`rejected ${request.method} ${request.url.split('?')[0]}: ${route.reason} token`)
    reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: UNAUTHORIZED_ERROR })
    return undefined
  }
  const guard = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      if (routeCall(request, reply) === undefined) {
        return reply
      }
      return undefined
    },
  }
  // Replies 503 itself and returns undefined when the key's bot isn't running.
  const requireBot = (route: KeyRoute, reply: FastifyReply): ApiBot | undefined => {
    if (route.bot === undefined) {
      reply.code(503).send({ error: BOT_UNAVAILABLE_ERROR })
    }
    return route.bot
  }
  if (admin !== undefined) {
    registerAdminRoutes(app, admin)
  }
  app.get('/status', guard, async (request) => requireRoute(request).status())
  app.get<{ Querystring: Record<string, unknown> }>('/log', guard, async (request, reply) => {
    const route = requireRoute(request)
    const query = parseLogQuery(request.query, new Date())
    if (!query.ok) {
      return reply.code(400).send({ error: query.error })
    }
    const { entries, skippedCount } = route.readLog(query.value)
    return { entries, skippedCount }
  })
  // Containers publish the same port on the host, so the local port is the one clients use.
  app.get('/openapi.yaml', async (request, reply) =>
    reply
      .type('application/yaml; charset=utf-8')
      .send(formatOpenApiYaml({ port: request.socket.localPort ?? 0, ...router.openApi() })),
  )
  // Replies 401/503/400/501 itself and returns undefined, or returns the bot and what `parse` made
  // of the body. The key is routed again because the upload can take a while: a key revoked or a
  // pairing reset meanwhile must not reach the old person. Drops the raw body from the Fastify
  // request so a long wait doesn't keep an attachment's bytes alive; the parsed JSON goes out of
  // scope on return for the same reason.
  const readBody = <T>(
    request: FastifyRequest<{ Body: string | undefined }>,
    reply: FastifyReply,
    parse: (bot: ApiBot, route: KeyRoute, json: unknown) => Parsed<T>,
  ): { readonly bot: ApiBot; readonly value: T } | undefined => {
    const body = request.body
    request.body = undefined
    const route = routeCall(request, reply)
    if (route === undefined) {
      return undefined
    }
    const bot = requireBot(route, reply)
    if (bot === undefined) {
      return undefined
    }
    if (route.person === undefined) {
      reply.code(503).send({ error: NOT_PAIRED_ERROR })
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
    const parsed = parse(bot, route, json)
    if (!parsed.ok) {
      reply.code(400).send({ error: parsed.error })
      return undefined
    }
    return { bot, value: parsed.value }
  }
  app.post<{ Body: string | undefined }>('/request', guard, async (request, reply) => {
    let read = readBody(request, reply, parseAsk)
    if (read === undefined) {
      return reply
    }
    const signal = abortOnClose(reply)
    const { retryCount } = read.value
    const pending = askWithRetries(read.bot.service, read.value.request, retryCount ?? 0, signal)
    // V8 keeps locals alive across await; drop the only handle on the attachment bytes first.
    read = undefined
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
    const read = readBody(request, reply, parseBackgroundAsk)
    if (read === undefined) {
      return reply
    }
    const { id, expiresAt } = await read.bot.service.start(read.value)
    return reply
      .code(202)
      .header('Location', `/request/${id}`)
      .send(toStateBody(id, { kind: 'pending', expiresAt }))
  })
  app.post<{ Body: string | undefined }>('/vote', guard, async (request, reply) => {
    let read = readBody(request, reply, parseVote)
    if (read === undefined) {
      return reply
    }
    const { rule } = read.value
    const pending = runVote(read.bot.service, read.value, abortOnClose(reply))
    read = undefined
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
      const route = requireRoute(request)
      const bot = requireBot(route, reply)
      if (bot === undefined) {
        return reply
      }
      const { id } = request.params
      const wait = parseWaitSeconds(request.query.wait)
      if (!wait.ok) {
        return reply.code(400).send({ error: wait.error })
      }
      const key = route.caller.key
      let state: RequestState | undefined
      if (wait.seconds === 0) {
        state = bot.service.get(id, key)
      } else {
        // Only stops this wait; the question stays open when the poller goes away.
        state = await bot.service.waitFor(id, key, wait.seconds * 1000, abortOnClose(reply))
      }
      if (state === undefined) {
        return reply.code(404).send({ error: UNKNOWN_REQUEST_ERROR })
      }
      return toStateBody(id, state)
    },
  )
  app.delete<{ Params: { id: string } }>('/request/:id', guard, async (request, reply) => {
    const route = requireRoute(request)
    const bot = requireBot(route, reply)
    if (bot === undefined) {
      return reply
    }
    const { id } = request.params
    const state = await bot.service.cancel(id, route.caller.key)
    if (state === undefined) {
      return reply.code(404).send({ error: UNKNOWN_REQUEST_ERROR })
    }
    return toStateBody(id, state)
  })
  app.post<{ Body: string | undefined }>('/notify', guard, async (request, reply) => {
    // Routed again after the upload, like readBody.
    const route = routeCall(request, reply)
    if (route === undefined) {
      return reply
    }
    const bot = requireBot(route, reply)
    if (bot === undefined) {
      return reply
    }
    const { notifications } = bot
    if (notifications === undefined) {
      return reply.code(501).send({ error: 'notifications not supported' })
    }
    if (route.person === undefined) {
      return reply.code(503).send({ error: NOT_PAIRED_ERROR })
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
    await notifications.notify(parsed.value, toRecipient(route.person))
    return { ok: true }
  })
  return app
}
