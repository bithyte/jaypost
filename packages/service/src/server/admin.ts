import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import {
  addBotBodySchema,
  createKeyBodySchema,
  createContactBodySchema,
  updateKeyBodySchema,
} from '@jaypost/protocol'
import { UNAUTHORIZED_ERROR } from '@jaypost/store'
import { ADMIN_FAILURE_STATUS } from './constants.ts'
import { parseAdminLogQuery, parseIdFilters } from './query.ts'
import type { AdminApi, AdminFailure, Parsed } from './types.ts'

type WithBody = { readonly Body: string | undefined }

type WithId = { readonly Params: { readonly id: string } }

type WithQuery = { readonly Querystring: Readonly<Record<string, unknown>> }

function isFailure(result: object): result is AdminFailure {
  return Object.hasOwn(result, 'kind')
}

/**
 * The first problem, naming only a top-level field: deeper path parts (setting names) and
 * unknown field names come from the body, which may hold a token.
 */
function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) {
    return 'body is invalid'
  }
  if (issue.code === 'unrecognized_keys') {
    return 'body has an unknown field'
  }
  if (issue.code === 'custom') {
    return issue.message
  }
  const field = issue.path[0]
  return `${typeof field === 'string' ? field : 'body'}: ${issue.message}`
}

/** The JSON body as `schema` parses it; the error never quotes the body. */
function parseBody<T>(raw: string | undefined, schema: z.ZodType<T>): Parsed<T> {
  let json: unknown
  try {
    json = JSON.parse(raw ?? '')
  } catch {
    return { ok: false, error: 'body must be valid JSON' }
  }
  const result = schema.safeParse(json)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: describeIssue(result.error.issues[0]) }
}

/** Sends `result` with `status`, or its failure's status and error. */
function send(reply: FastifyReply, result: object, status: number): FastifyReply {
  if (isFailure(result)) {
    return reply.code(ADMIN_FAILURE_STATUS[result.kind]).send({ error: result.error })
  }
  return reply.code(status).send(result)
}

/**
 * Registers the /admin routes on `app`. Every one needs `Authorization: Bearer <admin key>` and
 * answers 401 before reading the body otherwise, API keys included. Bodies are JSON; errors never
 * quote them.
 */
export function registerAdminRoutes(app: FastifyInstance, admin: AdminApi): void {
  const withBody = <T>(
    request: FastifyRequest<WithBody>,
    reply: FastifyReply,
    schema: z.ZodType<T>,
    run: (body: T) => object | Promise<object>,
    status: number,
  ): object | Promise<object> => {
    const body = parseBody(request.body, schema)
    if (!body.ok) {
      return reply.code(400).send({ error: body.error })
    }
    const result = run(body.value)
    return result instanceof Promise
      ? result.then((settled) => send(reply, settled, status))
      : send(reply, result, status)
  }
  void app.register(
    async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        if (admin.isAdmin(request.headers.authorization)) {
          return
        }
        console.error(`rejected ${request.method} ${request.url.split('?')[0]}: not the admin key`)
        return reply
          .code(401)
          .header('WWW-Authenticate', 'Bearer')
          .send({ error: UNAUTHORIZED_ERROR })
      })
      scope.get('/bots', async () => admin.listBots())
      scope.post<WithBody>('/bots', async (request, reply) =>
        withBody(request, reply, addBotBodySchema, (body) => admin.addBot(body), 201),
      )
      scope.delete<WithId>('/bots/:id', async (request, reply) =>
        send(reply, await admin.removeBot(request.params.id), 200),
      )
      scope.get<WithQuery>('/contacts', async (request, reply) => {
        const query = parseIdFilters(request.query, ['bot'])
        if (!query.ok) {
          return reply.code(400).send({ error: query.error })
        }
        return send(reply, admin.listContacts(query.value), 200)
      })
      scope.post<WithBody>('/contacts', async (request, reply) =>
        withBody(request, reply, createContactBodySchema, (body) => admin.createContact(body), 201),
      )
      scope.post<WithId>('/contacts/:id/reset', async (request, reply) =>
        send(reply, admin.resetContact(request.params.id), 200),
      )
      scope.delete<WithId>('/contacts/:id', async (request, reply) =>
        send(reply, admin.removeContact(request.params.id), 200),
      )
      scope.get<WithQuery>('/keys', async (request, reply) => {
        const query = parseIdFilters(request.query, ['bot', 'contact'])
        if (!query.ok) {
          return reply.code(400).send({ error: query.error })
        }
        return send(reply, admin.listKeys(query.value), 200)
      })
      scope.post<WithBody>('/keys', async (request, reply) =>
        withBody(request, reply, createKeyBodySchema, (body) => admin.createKey(body), 201),
      )
      scope.patch<WithBody & WithId>('/keys/:id', async (request, reply) =>
        withBody(
          request,
          reply,
          updateKeyBodySchema,
          (body) => admin.updateKey(request.params.id, body),
          200,
        ),
      )
      scope.delete<WithId>('/keys/:id', async (request, reply) =>
        send(reply, admin.revokeKey(request.params.id), 200),
      )
      scope.get<WithQuery>('/log', async (request, reply) => {
        const query = parseAdminLogQuery(request.query, new Date())
        if (!query.ok) {
          return reply.code(400).send({ error: query.error })
        }
        return send(reply, admin.readLog(query.value), 200)
      })
      scope.post('/admin-key', async (_request, reply) => send(reply, admin.rotateAdminKey(), 200))
    },
    { prefix: '/admin' },
  )
}
