import { stringify } from 'yaml'
import { z } from 'zod'
import {
  createApprovalRequestSchema,
  createAttachmentSchema,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_OPTION_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MAX_WAIT_SECONDS,
} from '../approval/index.ts'
import { VERSION } from '../config/index.ts'
import { createNotifyRequestSchema } from '../notify/index.ts'
import { MAX_BODY_BYTES } from './constants.ts'
import { statusInfoSchema } from './schema.ts'
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
      '`plain` (default) or `markdown`, a small subset: code spans and fenced blocks, bold, italic, strikethrough, headings and quotes. Anything else stays as typed. See Formatting in the README.',
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

const ATTACHMENT_DESCRIPTIONS: Readonly<Record<string, JsonSchema>> = {
  name: {
    description:
      'File name shown in Telegram. Its extension decides how Telegram opens it. Not trimmed; no `/`, `\\` or control characters, not `.` or `..`.',
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

/** Adds descriptions of the limit fields to both branches of the generated Status schema. */
function toStatusSchema(status: JsonSchema): JsonSchema {
  const descriptions: Readonly<Record<string, string>> = {
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

/** OpenAPI 3.1 document of the HTTP API, for a service on `port` with the given text limit. */
export function createOpenApiDocument(options: OpenApiOptions) {
  const { port, maxTextLength, maxAttachmentBytes, maxOptionCount } = options
  const { $schema: _schema, ...status } = z.toJSONSchema(statusInfoSchema)
  return {
    openapi: '3.1.0',
    info: {
      title: 'jaypost',
      version: VERSION,
      description:
        'Local HTTP API that asks you a question in a chat app with buttons and returns your answer.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    security: [{ bearerAuth: [] }],
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
              description: 'The tapped or typed answer, or `timeoutOption` on timeout.',
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
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'The token `init` saved to `~/.config/jaypost/token`. A service installed without a token ignores the header.',
        },
      },
      schemas: {
        ApprovalRequest: toBodySchema(
          createApprovalRequestSchema(maxTextLength, maxAttachmentBytes, maxOptionCount),
          maxTextLength,
        ),
        Attachment: toAttachmentSchema(maxAttachmentBytes),
        Outcome: {
          type: 'object',
          properties: {
            answer: {
              type: 'string',
              description: 'The tapped option, the typed reply, or `timeoutOption`.',
            },
            timedOut: { type: 'boolean' },
          },
          required: ['answer', 'timedOut'],
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
      },
      responses: {
        UnknownRequest: errorResponse(
          'Unknown id: never created, expired 24 h after settling, or lost to a restart.',
        ),
        Unauthorized: errorResponse('Missing or wrong bearer token.'),
        BadRequest: errorResponse(
          'Body is not valid JSON or fails validation; `error` is the first problem found. Nothing is sent.',
        ),
        PayloadTooLarge: errorResponse(`Body over ${MAX_BODY_BYTES} bytes.`),
        NotSupported: errorResponse(
          'Notifications or attachments are not supported by this provider.',
        ),
        SendFailed: errorResponse("The message couldn't be sent."),
        NotPaired: errorResponse('No owner is paired yet.'),
      },
    },
  }
}

/** `createOpenApiDocument` as YAML. */
export function formatOpenApiYaml(options: OpenApiOptions): string {
  return stringify(createOpenApiDocument(options), { lineWidth: 0 })
}
