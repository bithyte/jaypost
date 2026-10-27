import { stringify } from 'yaml'
import { z } from 'zod'
import {
  createApprovalRequestSchema,
  createAttachmentSchema,
  createNotifyRequestSchema,
  createVoteFieldsSchema,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_OPTION_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MAX_WAIT_SECONDS,
} from '@jaypost/core'
import {
  addBotBodySchema,
  adminBotSchema,
  adminKeySchema,
  adminPairingSchema,
  createdKeySchema,
  createKeyBodySchema,
  createPairingBodySchema,
  logEntrySchema,
  MAX_LABEL_LENGTH,
  removedKeysSchema,
  rotatedAdminKeySchema,
  statusInfoSchema,
  updateKeyBodySchema,
} from '@jaypost/protocol'
import { MAX_BODY_BYTES } from './constants.ts'
import type { OpenApiOptions } from './types.ts'

type JsonSchema = z.core.JSONSchema.BaseSchema

// A fresh object per use, so the yaml writer doesn't emit anchors and aliases.
function attachmentReference(): { $ref: string } {
  return { $ref: '#/components/schemas/Attachment' }
}

function toTextDescription(maxTextLength: number): string {
  return `Message shown in the chat. Must not be blank, at most ${maxTextLength} characters; with \`format: markdown\` the markup is removed before counting. With \`project\`, the limit covers the \`[project]\` line too, so the text gets \`project.length + 4\` fewer characters.`
}

const BODY_DESCRIPTIONS: Readonly<Record<string, JsonSchema>> = {
  project: { description: 'Shown as `[project]` on the first line. Trimmed.' },
  format: {
    description:
      '`plain` (default) or `markdown`, a small subset: code spans and fenced blocks, bold, italic, strikethrough, headings and quotes. Anything else stays as typed. See docs/formatting.md in the repo.',
  },
  deleteAfter: {
    description:
      'When the notification is deleted: seconds after it is sent, or an ISO 8601 timestamp with a timezone. Not shifted by quiet hours; capped at 47 hours. Default 8 hours, starting when quiet hours end.',
  },
  allowText: { description: 'Let the owner answer by replying with text. Default false.' },
  options: {
    description:
      'Button labels, unique. Required and non-empty unless `allowText`; with it, may be omitted or empty for a text-only question.',
  },
  timeoutOption: {
    description: `Answer returned on timeout. Without \`allowText\`, must be one of \`options\`; with it, any non-empty string of at most ${MAX_OPTION_LENGTH} characters.`,
  },
  timeout: {
    description: `Seconds to wait. Default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS} (24 h); larger values are clamped.`,
  },
}

const VOTE_DESCRIPTIONS: Readonly<Record<string, JsonSchema>> = {
  voters: {
    description:
      'User ids to ask, one message each; default the owner. Each must have started a chat with the bot. Duplicates count once.',
  },
  require: { description: '`all` voters must approve (default), or a `majority` of them.' },
  retry: {
    description:
      'Rounds after the first; each re-asks only voters who timed out. Default 0. Running out of rounds rejects.',
  },
}

/** The `retry` property of the vote fields, also accepted by POST /request. */
function toRetrySchema(): JsonSchema {
  const retry = z.toJSONSchema(createVoteFieldsSchema(), { io: 'input' }).properties?.retry
  return {
    ...(typeof retry === 'object' ? retry : {}),
    description:
      'Ask again after a timeout up to this many times; the answer then has `rounds`. `/request/async` answers 400 to it.',
  }
}

/** The fields a /vote body adds to ApprovalRequest, with `retry` described for votes. */
function toVoteFieldsSchema(): JsonSchema {
  const {
    $schema: _schema,
    additionalProperties: _additional,
    ...json
  } = z.toJSONSchema(createVoteFieldsSchema(), { io: 'input' })
  const properties = Object.fromEntries(
    Object.entries(json.properties ?? {}).map(([name, property]) => [
      name,
      typeof property === 'object' ? { ...property, ...VOTE_DESCRIPTIONS[name] } : property,
    ]),
  )
  return { ...json, properties }
}

const ATTACHMENT_DESCRIPTIONS: Readonly<Record<string, JsonSchema>> = {
  name: {
    description:
      'File name shown in the chat app. Its extension decides how the app opens it. Not trimmed; no `/`, `\\` or control characters, not `.` or `..`.',
  },
  text: { description: 'File contents as UTF-8 text. Exactly one of `text` and `data`.' },
  data: {
    description:
      'File contents as base64 (standard alphabet, padding optional, line breaks allowed). Exactly one of `text` and `data`.',
  },
}

function toAttachmentSchema(maxAttachmentBytes: number): JsonSchema {
  const { $schema: _schema, ...json } = z.toJSONSchema(createAttachmentSchema(maxAttachmentBytes), {
    io: 'input',
  })
  const limit =
    maxAttachmentBytes === 0
      ? 'Attachments are not supported by this provider (501).'
      : `Decoded size 1 to ${maxAttachmentBytes} bytes. Send big files as data; heavy JSON escaping in text can push the body over the size limit.`
  const properties = Object.fromEntries(
    Object.entries(json.properties ?? {}).map(([name, property]) => [
      name,
      typeof property === 'object' ? { ...property, ...ATTACHMENT_DESCRIPTIONS[name] } : property,
    ]),
  )
  return {
    ...json,
    description: `An optional file sent to the chat as a document with the message. Exactly one of \`text\` (UTF-8) or \`data\` (standard base64, line breaks allowed). ${limit}`,
    properties,
  }
}

function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  }
}

/** Input side of a body schema, with `$schema` dropped and descriptions and the text limit added. */
function toBodySchema(schema: z.ZodType, maxTextLength: number): JsonSchema {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema, { io: 'input' })
  const extras: Readonly<Record<string, JsonSchema>> = {
    ...BODY_DESCRIPTIONS,
    text: { minLength: 1, description: toTextDescription(maxTextLength) },
  }
  const properties = Object.fromEntries(
    Object.entries(json.properties ?? {}).map(([name, property]) => [
      name,
      typeof property === 'object' ? { ...property, ...extras[name] } : property,
    ]),
  )
  return { ...json, properties: { ...properties, attachment: attachmentReference() } }
}

/** The /request body with `retry`, which POST /request/async refuses. */
function toApprovalRequestSchema(body: JsonSchema): JsonSchema {
  return { ...body, properties: { ...body.properties, retry: toRetrySchema() } }
}

/** Adds descriptions of the limit fields to both branches of the generated Status schema. */
function toStatusSchema(status: JsonSchema): JsonSchema {
  const descriptions: Readonly<Record<string, string>> = {
    key: "The caller key's id.",
    pairing: "The id of the caller key's pairing.",
    state:
      "Where the key's bot is: `starting`, `running`, or `failed` (with `error`) and retried with backoff. Question routes answer 503 unless `running`.",
    error: 'Why the bot failed; present only when `state` is `failed`.',
    maxTextLength: 'Most characters a request text may have.',
    maxOptionCount: 'Most options a request may have; absent means no provider limit',
  }
  return {
    ...status,
    oneOf: (status.oneOf ?? []).map((branch) => ({
      ...branch,
      properties: Object.fromEntries(
        Object.entries(branch.properties ?? {}).map(([name, property]) => [
          name,
          typeof property === 'object' && Object.hasOwn(descriptions, name)
            ? { ...property, description: descriptions[name] }
            : property,
        ]),
      ),
    })),
  }
}

/** A Zod schema as a component, without `$schema`; `input` for request bodies. */
function toComponentSchema(schema: z.ZodType, io: 'input' | 'output' = 'output'): JsonSchema {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema, { io })
  return json
}

// Fresh objects per use, like attachmentReference.
function componentReference(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` }
}

function jsonBody(name: string) {
  return { required: true, content: { 'application/json': { schema: componentReference(name) } } }
}

function jsonResponse(description: string, name: string) {
  return { description, content: { 'application/json': { schema: componentReference(name) } } }
}

/** A 200/201 whose body is `{ [property]: <schema> }`. */
function wrappedResponse(description: string, property: string, schema: JsonSchema) {
  return {
    description,
    content: {
      'application/json': {
        schema: { type: 'object', properties: { [property]: schema }, required: [property] },
      },
    },
  }
}

function listOf(name: string): JsonSchema {
  return { type: 'array', items: componentReference(name) }
}

function idParameter(name: string) {
  return { $ref: `#/components/parameters/${name}` }
}

function filterParameter(name: string, description: string) {
  return { name, in: 'query', required: false, description, schema: { type: 'string' } }
}

function unknownId() {
  return { $ref: '#/components/responses/UnknownId' }
}

type AdminOperation = {
  readonly operationId: string
  readonly summary: string
  readonly description?: string
  readonly parameters?: readonly unknown[]
  readonly requestBody?: unknown
  readonly responses: Readonly<Record<string, unknown>>
  /** False for reads, which save nothing and so can't fail a save. */
  readonly saves?: boolean
}

/** An admin route: tagged `admin`, behind the admin key, with its 401 (and 500 when it saves). */
function adminOperation(operation: AdminOperation) {
  const { saves, responses, ...rest } = operation
  return {
    tags: ['admin'],
    security: [{ adminKey: [] }],
    ...rest,
    responses: {
      ...responses,
      '401': { $ref: '#/components/responses/Unauthorized' },
      ...(saves === false ? {} : { '500': { $ref: '#/components/responses/SaveFailed' } }),
    },
  }
}

function logQueryParameters() {
  return [
    filterParameter(
      'since',
      'Only questions asked since then: a duration like `30m`, `12h` or `7d`, a date or an ISO date-time.',
    ),
    filterParameter('project', 'Only questions with this `project`.'),
    {
      name: 'limit',
      in: 'query',
      required: false,
      description: 'Only the last this many questions.',
      schema: { type: 'integer', minimum: 1 },
    },
  ]
}

/** The /admin paths. */
function createAdminPaths() {
  return {
    '/admin/bots': {
      get: adminOperation({
        operationId: 'listBots',
        summary: 'List bots',
        saves: false,
        responses: {
          '200': wrappedResponse(
            'Every stored bot, never its settings.',
            'bots',
            listOf('AdminBot'),
          ),
        },
      }),
      post: adminOperation({
        operationId: 'addBot',
        summary: 'Add a bot and start it',
        description:
          'Parses each setting, asks the provider to check the credentials, saves the bot and waits for its first start attempt. No restart needed.',
        requestBody: jsonBody('AddBotBody'),
        responses: {
          '201': wrappedResponse('Added.', 'bot', componentReference('AdminBot')),
          '400': errorResponse(
            'Unknown provider; a missing, invalid or unknown setting; the owner setting; or credentials the provider rejected, with its reason. Never quotes a setting value.',
          ),
          '409': errorResponse('Another stored bot already uses these credentials.'),
        },
      }),
    },
    '/admin/bots/{id}': {
      delete: adminOperation({
        operationId: 'removeBot',
        summary: 'Remove a bot with its pairings and keys',
        description:
          'Stops the bot. Its open questions are answered with their timeout option. Its questions stay readable in the log until they are 30 days old; its pairings, keys and saved state are deleted.',
        parameters: [idParameter('BotId')],
        responses: {
          '200': jsonResponse(
            'Removed; `removedKeys` are the keys that went with it.',
            'RemovedKeys',
          ),
          '404': unknownId(),
        },
      }),
    },
    '/admin/pairings': {
      get: adminOperation({
        operationId: 'listPairings',
        summary: 'List pairings',
        saves: false,
        parameters: [filterParameter('bot', "Only this bot's pairings.")],
        responses: {
          '200': wrappedResponse(
            'The pairings, with their keys and, while pending, their code.',
            'pairings',
            listOf('AdminPairing'),
          ),
          '400': errorResponse('A filter was given more than once.'),
          '404': unknownId(),
        },
      }),
      post: adminOperation({
        operationId: 'createPairing',
        summary: 'Invite an approver',
        description:
          "A pairing with no key, waiting for its code. On a bot that doesn't pair, the bot's one pairing.",
        requestBody: jsonBody('CreatePairingBody'),
        responses: {
          '201': jsonResponse('The pairing and, while pending, its code.', 'PairingInvite'),
          '400': { $ref: '#/components/responses/AdminBadRequest' },
          '404': unknownId(),
        },
      }),
    },
    '/admin/pairings/{id}/reset': {
      post: adminOperation({
        operationId: 'resetPairing',
        summary: "Remove a pairing's person and wait for a new one",
        description:
          'Its keys stay and wait for the new code. Their open questions are answered with their timeout option.',
        parameters: [idParameter('PairingId')],
        responses: {
          '200': jsonResponse('The pending pairing and its new code.', 'PairingInvite'),
          '400': errorResponse("The pairing is on a bot that doesn't pair."),
          '404': unknownId(),
        },
      }),
    },
    '/admin/pairings/{id}': {
      delete: adminOperation({
        operationId: 'removePairing',
        summary: 'Remove a pairing and revoke its keys',
        description: 'Their open questions are answered with their timeout option.',
        parameters: [idParameter('PairingId')],
        responses: {
          '200': jsonResponse('Removed; `removedKeys` are the revoked keys.', 'RemovedKeys'),
          '404': unknownId(),
        },
      }),
    },
    '/admin/keys': {
      get: adminOperation({
        operationId: 'listKeys',
        summary: 'List API keys',
        saves: false,
        parameters: [
          filterParameter('bot', "Only keys on this bot's pairings."),
          filterParameter('pairing', 'Only keys on this pairing.'),
        ],
        responses: {
          '200': wrappedResponse(
            'The keys, never their hashes or plaintext.',
            'keys',
            listOf('AdminKey'),
          ),
          '400': errorResponse('A filter was given more than once.'),
          '404': unknownId(),
        },
      }),
      post: adminOperation({
        operationId: 'createKey',
        summary: 'Create an API key',
        description:
          'On a new pairing (`bot`), the key waits until someone sends the code to the bot. On an existing pairing (`pairing` or `sameAsKey`), it works at once.',
        requestBody: jsonBody('CreateKeyBody'),
        responses: {
          '201': jsonResponse(
            'The key. `key` is the plaintext, shown only in this response.',
            'CreatedKey',
          ),
          '400': { $ref: '#/components/responses/AdminBadRequest' },
          '404': unknownId(),
        },
      }),
    },
    '/admin/keys/{id}': {
      patch: adminOperation({
        operationId: 'updateKey',
        summary: "Change a key's label or external id",
        parameters: [idParameter('KeyId')],
        requestBody: jsonBody('UpdateKeyBody'),
        responses: {
          '200': wrappedResponse('The key as it is now.', 'key', componentReference('AdminKey')),
          '400': { $ref: '#/components/responses/AdminBadRequest' },
          '404': unknownId(),
        },
      }),
      delete: adminOperation({
        operationId: 'revokeKey',
        summary: 'Revoke an API key',
        description:
          'Its open questions are answered with their timeout option. Its pairing stays.',
        parameters: [idParameter('KeyId')],
        responses: {
          '200': {
            description: 'Revoked; an empty object.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': unknownId(),
        },
      }),
    },
    '/admin/log': {
      get: adminOperation({
        operationId: 'readAdminLog',
        summary: "Every bot's questions",
        description:
          'Oldest first, each with its bot, removed bots included while their questions are under 30 days old. `pairing` and `key` may name removed ones, so their history stays readable.',
        saves: false,
        parameters: [
          filterParameter('bot', "Only this bot's questions."),
          filterParameter('pairing', "Only this pairing's questions."),
          filterParameter('key', "Only this key's questions."),
          ...logQueryParameters(),
        ],
        responses: {
          '200': jsonResponse('The questions.', 'LogPage'),
          '400': errorResponse('A query parameter is invalid or given more than once.'),
          '404': unknownId(),
        },
      }),
    },
    '/admin/admin-key': {
      post: adminOperation({
        operationId: 'rotateAdminKey',
        summary: 'Replace the admin key',
        description: 'Writes the new key to the admin key file; the old key stops working at once.',
        responses: {
          '200': jsonResponse('The new admin key.', 'RotatedAdminKey'),
        },
      }),
    },
  }
}

/** OpenAPI 3.1 document of the HTTP API, for a service on `port` with the given text limit. */
export function createOpenApiDocument(options: OpenApiOptions) {
  const { version, port, maxTextLength, maxAttachmentBytes, maxOptionCount } = options
  const { $schema: _schema, ...status } = z.toJSONSchema(statusInfoSchema)
  return {
    openapi: '3.1.0',
    info: {
      title: 'jaypost',
      version,
      description:
        'Local HTTP API that asks you a question in a chat app with buttons and returns your answer.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    security: [{ bearerAuth: [] }],
    tags: [
      {
        name: 'admin',
        description:
          'Managing bots, pairings and keys. Needs the admin key; an API key gets 401 like a missing one.',
      },
    ],
    paths: {
      '/request': {
        post: {
          operationId: 'request',
          summary: 'Ask a question and wait for the answer',
          description:
            'Stays open until the owner answers (tap, or text reply with `allowText`) or the timeout fires. Disconnecting cancels the question.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApprovalRequest' } },
            },
          },
          responses: {
            '200': {
              description:
                'The tapped or typed answer, or `timeoutOption` on timeout; with `retry`, also the rounds asked.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Outcome' } },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '500': errorResponse('Internal error, or the request was cancelled.'),
            '502': { $ref: '#/components/responses/SendFailed' },
            '501': { $ref: '#/components/responses/NotSupported' },
            '503': { $ref: '#/components/responses/NotPaired' },
          },
        },
      },
      '/request/async': {
        post: {
          operationId: 'requestAsync',
          summary: 'Ask a question with buttons and return at once',
          description:
            'Returns once the message is sent. Poll `GET /request/{id}` for the answer. The question outlives the connection and is cancelled only by `DELETE /request/{id}`, the timeout or the owner.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApprovalRequest' } },
            },
          },
          responses: {
            '202': {
              description: 'Sent and pending.',
              headers: {
                Location: {
                  description: 'Path of the question, `/request/{id}`.',
                  schema: { type: 'string' },
                },
              },
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/PendingRequest' } },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '502': { $ref: '#/components/responses/SendFailed' },
            '501': { $ref: '#/components/responses/NotSupported' },
            '503': { $ref: '#/components/responses/NotPaired' },
          },
        },
      },
      '/request/{id}': {
        get: {
          operationId: 'getRequest',
          summary: 'State of a background question, optionally waiting for it to settle',
          description:
            'Without `wait` answers at once. With `wait`, stays open until the question settles or `wait` seconds pass, then returns the state. Disconnecting does not cancel the question.',
          parameters: [
            { $ref: '#/components/parameters/RequestId' },
            {
              name: 'wait',
              in: 'query',
              required: false,
              description: `Seconds to wait for the question to settle. Default 0; values above ${MAX_WAIT_SECONDS} are clamped.`,
              schema: { type: 'number', minimum: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'The current state.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/RequestState' } },
              },
            },
            '400': errorResponse('`wait` is not a non-negative number.'),
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/UnknownRequest' },
            '503': { $ref: '#/components/responses/BotUnavailable' },
          },
        },
        delete: {
          operationId: 'cancelRequest',
          summary: 'Cancel a background question',
          description:
            'Cancels a pending question and edits its message to a cancelled line. A settled question keeps its state.',
          parameters: [{ $ref: '#/components/parameters/RequestId' }],
          responses: {
            '200': {
              description: 'The state after the call: `cancelled`, or the earlier `done`.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/RequestState' } },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/UnknownRequest' },
            '503': { $ref: '#/components/responses/BotUnavailable' },
          },
        },
      },
      '/vote': {
        post: {
          operationId: 'vote',
          summary: 'Ask several people the same yes/no question and wait for the decision',
          description:
            'Sends one message per voter and stays open until the vote is decided or its rounds run out. `options` must be `[approve, reject]` and `timeoutOption` the reject answer, without `allowText`. Once decided, every open message is closed with the result. Disconnecting cancels every open message.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/VoteRequest' } },
            },
          },
          responses: {
            '200': {
              description: "The decision and each voter's answer.",
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/VoteReport' } },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '500': errorResponse('Internal error, or the vote was cancelled.'),
            '501': { $ref: '#/components/responses/NotSupported' },
            '502': {
              description:
                "A voter's message couldn't be sent; `voter` names them. The messages already sent are cancelled.",
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { error: { type: 'string' }, voter: { type: 'string' } },
                    required: ['error', 'voter'],
                  },
                },
              },
            },
            '503': { $ref: '#/components/responses/NotPaired' },
          },
        },
      },
      '/notify': {
        post: {
          operationId: 'notify',
          summary: "Send a message that doesn't need an answer",
          description:
            'Returns once the message is sent. The message has a Dismiss button and is deleted automatically later.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/NotifyRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Sent.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { const: true } },
                    required: ['ok'],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '502': { $ref: '#/components/responses/SendFailed' },
            '501': { $ref: '#/components/responses/NotSupported' },
            '503': { $ref: '#/components/responses/NotPaired' },
          },
        },
      },
      '/status': {
        get: {
          operationId: 'status',
          summary: 'Pairing state',
          responses: {
            '200': {
              description: '`code` and `instructions` are present only while unpaired.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Status' } },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/log': {
        get: {
          operationId: 'log',
          summary: "The caller key's questions",
          description: 'Oldest first. Only the questions asked with the caller key.',
          parameters: logQueryParameters(),
          responses: {
            '200': jsonResponse('The questions.', 'LogPage'),
            '400': errorResponse('A query parameter is invalid or given more than once.'),
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/openapi.yaml': {
        get: {
          operationId: 'openapi',
          summary: 'This document',
          security: [],
          responses: {
            '200': {
              description: 'OpenAPI document for this service.',
              content: { 'application/yaml': { schema: { type: 'string' } } },
            },
          },
        },
      },
      ...createAdminPaths(),
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API key, such as the one `init` saved to `~/.config/jaypost/token`. A service installed without a token treats a call without the header as its first key.',
        },
        adminKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'The admin key, in `~/.config/jaypost/admin-key` on the machine running the service. Only the admin routes take it.',
        },
      },
      schemas: {
        ApprovalRequest: toApprovalRequestSchema(
          toBodySchema(
            createApprovalRequestSchema(maxTextLength, maxAttachmentBytes, maxOptionCount),
            maxTextLength,
          ),
        ),
        VoteRequest: {
          allOf: [{ $ref: '#/components/schemas/ApprovalRequest' }, toVoteFieldsSchema()],
        },
        Attachment: toAttachmentSchema(maxAttachmentBytes),
        Outcome: {
          type: 'object',
          properties: {
            answer: {
              type: 'string',
              description: 'The tapped option, the typed reply, or `timeoutOption`.',
            },
            timedOut: { type: 'boolean' },
            rounds: {
              type: 'integer',
              minimum: 1,
              description: 'Rounds asked; present only when the body had `retry`.',
            },
          },
          required: ['answer', 'timedOut'],
        },
        VoteReport: {
          type: 'object',
          properties: {
            answer: {
              type: 'string',
              description: 'The first option when approved, else the second.',
            },
            timedOut: {
              type: 'boolean',
              description: 'The rounds ran out undecided, which rejects.',
            },
            approved: { type: 'boolean' },
            require: { type: 'string', enum: ['all', 'majority'] },
            votes: {
              type: 'object',
              description: "Each voter's answer, `null` when they never voted.",
              additionalProperties: { type: ['string', 'null'] },
            },
            rounds: { type: 'integer', minimum: 1 },
          },
          required: ['answer', 'timedOut', 'approved', 'require', 'votes', 'rounds'],
        },
        PendingRequest: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            state: { const: 'pending' },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'When the timeout fires.',
            },
          },
          required: ['id', 'state', 'expiresAt'],
        },
        RequestState: {
          oneOf: [
            { $ref: '#/components/schemas/PendingRequest' },
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                state: { const: 'done' },
                answer: { type: 'string', description: 'The tapped option, or `timeoutOption`.' },
                timedOut: { type: 'boolean' },
              },
              required: ['id', 'state', 'answer', 'timedOut'],
            },
            {
              type: 'object',
              properties: { id: { type: 'string' }, state: { const: 'cancelled' } },
              required: ['id', 'state'],
            },
          ],
        },
        NotifyRequest: toBodySchema(
          createNotifyRequestSchema(maxTextLength, maxAttachmentBytes),
          maxTextLength,
        ),
        Status: toStatusSchema(status),
        LogEntry: toComponentSchema(logEntrySchema),
        LogPage: {
          type: 'object',
          properties: {
            entries: listOf('LogEntry'),
            skippedCount: {
              type: 'integer',
              minimum: 0,
              description: "Log lines that couldn't be read.",
            },
          },
          required: ['entries', 'skippedCount'],
        },
        AddBotBody: {
          ...toComponentSchema(addBotBodySchema, 'input'),
          description: `\`settings\` by config key, as \`init\` asks for them, without the owner. \`label\` is at most ${MAX_LABEL_LENGTH} characters.`,
        },
        CreatePairingBody: toComponentSchema(createPairingBodySchema, 'input'),
        CreateKeyBody: {
          ...toComponentSchema(createKeyBodySchema, 'input'),
          description: `Exactly one of \`bot\` (a new pairing on that bot), \`pairing\` or \`sameAsKey\` (that key's pairing). \`label\` and \`externalId\` are stored and never interpreted, at most ${MAX_LABEL_LENGTH} characters.`,
        },
        UpdateKeyBody: {
          ...toComponentSchema(updateKeyBodySchema, 'input'),
          description: 'A string sets the field, `null` deletes it, and a missing field stays.',
        },
        AdminBot: toComponentSchema(adminBotSchema),
        AdminPairing: toComponentSchema(adminPairingSchema),
        AdminKey: toComponentSchema(adminKeySchema),
        CreatedKey: toComponentSchema(createdKeySchema),
        PairingInvite: {
          type: 'object',
          properties: {
            pairing: componentReference('AdminPairing'),
            code: { type: 'string', description: 'Present while the pairing waits for it.' },
            instructions: { type: 'string', description: 'How to send the code to the bot.' },
          },
          required: ['pairing'],
        },
        RemovedKeys: toComponentSchema(removedKeysSchema),
        RotatedAdminKey: toComponentSchema(rotatedAdminKeySchema),
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
      },
      parameters: {
        RequestId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Id from `POST /request/async`.',
          schema: { type: 'string' },
        },
        BotId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'A bot id, such as `b1`.',
          schema: { type: 'string' },
        },
        PairingId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'A pairing id, such as `p1`.',
          schema: { type: 'string' },
        },
        KeyId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'An API key id, such as `k1`.',
          schema: { type: 'string' },
        },
      },
      responses: {
        UnknownRequest: errorResponse(
          'Unknown id: never created, expired 24 h after settling, or lost to a restart.',
        ),
        Unauthorized: errorResponse(
          'Missing or wrong bearer token. On admin routes, anything but the admin key.',
        ),
        BadRequest: errorResponse(
          'Body is not valid JSON or fails validation; `error` is the first problem found. Nothing is sent.',
        ),
        PayloadTooLarge: errorResponse(`Body over ${MAX_BODY_BYTES} bytes.`),
        NotSupported: errorResponse(
          'Notifications or attachments are not supported by this provider.',
        ),
        SendFailed: errorResponse("The message couldn't be sent."),
        NotPaired: errorResponse(
          "The key's pairing waits for its code (`not paired`), or its bot isn't running (`bot unavailable`).",
        ),
        BotUnavailable: errorResponse(
          "The key's bot isn't running (`bot unavailable`); it is starting or failed.",
        ),
        AdminBadRequest: errorResponse(
          'Body is not valid JSON or fails validation; `error` names the field, never its value.',
        ),
        UnknownId: errorResponse('Unknown id, named in `error`: `unknown key "k9"`.'),
        SaveFailed: errorResponse(
          "The registry or admin key file couldn't be written; nothing changed.",
        ),
      },
    },
  }
}

/** `createOpenApiDocument` as YAML. */
export function formatOpenApiYaml(options: OpenApiOptions): string {
  return stringify(createOpenApiDocument(options), { lineWidth: 0 })
}
