import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { parseApprovalRequest, parseWaitSeconds, SendError } from '../approval/index.ts'
import type { ApprovalRequest, ApprovalService, RequestState } from '../approval/index.ts'
import { isAuthorized, UNAUTHORIZED_ERROR } from '../auth/index.ts'
import { parseNotifyRequest } from '../notify/index.ts'
import {
  ATTACHMENTS_UNSUPPORTED_ERROR,
  MAX_BODY_BYTES,
  REQUEST_ID_PATH_PATTERN,
  UNKNOWN_REQUEST_ERROR,
} from './constants.ts'
import { formatOpenApiYaml } from './openapi.ts'
import type { ApiServerOptions, StatusInfo } from './types.ts'

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

function hasAttachmentKey(json: unknown): boolean {
  return typeof json === 'object' && json !== null && Object.hasOwn(json, 'attachment')
}

/**
 * Builds the HTTP API (POST /request, POST /request/async, GET and DELETE /request/:id,
 * POST /notify, GET /status, GET /openapi.yaml) without listening. Aborting the connection cancels
 * a pending /request; background questions outlive their connections. Errors return JSON bodies.
 * With a token in `options.auth`, every route but /openapi.yaml answers 401 before parsing the
 * body or touching the service. Without `options.notifications`, POST /notify answers 501.
 */
export function createApiServer(
  service: Pick<ApprovalService, 'request' | 'start' | 'get' | 'waitFor' | 'cancel'>,
  status: () => StatusInfo,
  options: ApiServerOptions,
): FastifyInstance {
  const { maxTextLength, maxOptionCount, providerName, notifications, auth } = options
  const attachmentLimit = options.maxAttachmentBytes ?? 0
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
    if (path === '/request' || path === '/request/async' || path === '/notify') {
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
    if (error instanceof SendError) {
      // Log the message only; the cause can hold provider internals.
      console.error(`${error.message} via ${providerName}`)
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
  const guard =
    auth.kind === 'token'
      ? {
          onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
            if (isAuthorized(request.headers.authorization, auth.token)) {
              return
            }
            const reason = request.headers.authorization === undefined ? 'missing' : 'wrong'
            console.error(
              `rejected ${request.method} ${request.url.split('?')[0]}: ${reason} token`,
            )
            return reply
              .code(401)
              .header('WWW-Authenticate', 'Bearer')
              .send({ error: UNAUTHORIZED_ERROR })
          },
        }
      : {}
  app.get('/status', guard, async () => ({
    ...status(),
    maxAttachmentBytes: attachmentLimit,
    maxTextLength,
    ...(maxOptionCount === undefined ? {} : { maxOptionCount }),
  }))
  // Containers publish the same port on the host, so the local port is the one clients use.
  app.get('/openapi.yaml', async (request, reply) =>
    reply.type('application/yaml; charset=utf-8').send(
      formatOpenApiYaml({
        port: request.socket.localPort ?? 0,
        maxTextLength,
        maxAttachmentBytes: attachmentLimit,
        ...(maxOptionCount === undefined ? {} : { maxOptionCount }),
      }),
    ),
  )
  // Replies 503/400/501 itself and returns undefined, or returns the validated request. Drops the
  // raw body from the Fastify request so a long wait doesn't keep an attachment's bytes alive.
  const readApprovalRequest = (
    request: FastifyRequest<{ Body: string | undefined }>,
    reply: FastifyReply,
  ): ApprovalRequest | undefined => {
    const body = request.body
    request.body = undefined
    if (!status().paired) {
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
    if (attachmentLimit === 0 && hasAttachmentKey(json)) {
      reply.code(501).send({ error: ATTACHMENTS_UNSUPPORTED_ERROR })
      return undefined
    }
    const parsed = parseApprovalRequest(json, maxTextLength, attachmentLimit, maxOptionCount)
    if (!parsed.ok) {
      reply.code(400).send({ error: parsed.error })
      return undefined
    }
    return parsed.value
  }
  app.post<{ Body: string | undefined }>('/request', guard, async (request, reply) => {
    let approval = readApprovalRequest(request, reply)
    if (approval === undefined) {
      return reply
    }
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
    const pending = service.request(approval, controller.signal)
    // V8 keeps locals alive across await; drop the only handle on the attachment bytes first.
    approval = undefined
    const result = await pending
    if (result.kind === 'cancelled') {
      // Normally because the client is gone, so this write is a no-op.
      return reply.code(500).send({ error: 'request was cancelled' })
    }
    return result.outcome
  })
  app.post<{ Body: string | undefined }>('/request/async', guard, async (request, reply) => {
    const approval = readApprovalRequest(request, reply)
    if (approval === undefined) {
      return reply
    }
    const { id, expiresAt } = await service.start(approval)
    return reply
      .code(202)
      .header('Location', `/request/${id}`)
      .send(toStateBody(id, { kind: 'pending', expiresAt }))
  })
  app.get<{ Params: { id: string }; Querystring: { wait?: unknown } }>(
    '/request/:id',
    guard,
    async (request, reply) => {
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
        const controller = new AbortController()
        reply.raw.on('close', () => {
          if (!reply.raw.writableEnded) {
            controller.abort()
          }
        })
        if (reply.raw.destroyed) {
          controller.abort()
        }
        state = await service.waitFor(id, wait.seconds * 1000, controller.signal)
      }
      if (state === undefined) {
        return reply.code(404).send({ error: UNKNOWN_REQUEST_ERROR })
      }
      return toStateBody(id, state)
    },
  )
  app.delete<{ Params: { id: string } }>('/request/:id', guard, async (request, reply) => {
    const { id } = request.params
    const state = await service.cancel(id)
    if (state === undefined) {
      return reply.code(404).send({ error: UNKNOWN_REQUEST_ERROR })
    }
    return toStateBody(id, state)
  })
  app.post<{ Body: string | undefined }>('/notify', guard, async (request, reply) => {
    if (notifications === undefined) {
      return reply.code(501).send({ error: 'notifications not supported' })
    }
    if (!status().paired) {
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
    if (attachmentLimit === 0 && hasAttachmentKey(json)) {
      return reply.code(501).send({ error: ATTACHMENTS_UNSUPPORTED_ERROR })
    }
    const parsed = parseNotifyRequest(json, maxTextLength, attachmentLimit)
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error })
    }
    await notifications.notify(parsed.value)
    return { ok: true }
  })
  return app
}
