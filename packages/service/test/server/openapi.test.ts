import { readFileSync } from 'node:fs'
import { expect, test } from 'vite-plus/test'
import { parse } from 'yaml'
import { DEFAULT_PORT } from '@jaypost/store'
import { DEFAULT_PROVIDER, requireProvider, resolveMaxAttachmentBytes } from '@jaypost/core'
import { PROVIDERS } from '@jaypost/providers'
import { createOpenApiDocument, formatOpenApiYaml } from '../../src/server/index.ts'
import packageJson from '../../../../apps/cli/package.json' with { type: 'json' }

const TEST_VERSION = '1.2.3'

test('docs/openapi.yaml is up to date (vp run openapi)', () => {
  const provider = requireProvider(PROVIDERS, DEFAULT_PROVIDER)
  const maxTextLength = provider.maxTextLength
  const maxAttachmentBytes = resolveMaxAttachmentBytes(provider)
  const committed = readFileSync(new URL('../../../../docs/openapi.yaml', import.meta.url), 'utf8')
  expect(committed).toBe(
    formatOpenApiYaml({
      version: packageJson.version,
      port: DEFAULT_PORT,
      maxTextLength,
      maxAttachmentBytes,
      ...(provider.maxOptionCount === undefined ? {} : { maxOptionCount: provider.maxOptionCount }),
    }),
  )
})

test('server url and text limits follow the options', () => {
  const document = createOpenApiDocument({
    version: TEST_VERSION,
    port: 9000,
    maxTextLength: 1234,
    maxAttachmentBytes: 0,
  })
  expect(document.info.version).toBe(TEST_VERSION)
  expect(document.servers).toEqual([{ url: 'http://127.0.0.1:9000' }])
  const { ApprovalRequest, NotifyRequest } = document.components.schemas
  for (const body of [ApprovalRequest, NotifyRequest]) {
    expect(body.properties?.text).toMatchObject({ minLength: 1 })
    expect(body.properties?.text).not.toHaveProperty('maxLength')
    expect(body.properties?.text).toMatchObject({
      description: expect.stringContaining('1234'),
    })
    expect(body.properties?.text).toMatchObject({
      description: expect.stringContaining('markdown'),
    })
    expect(body.properties?.format).toMatchObject({ enum: ['plain', 'markdown'] })
  }
})

test('request bodies come from the parser schemas', () => {
  const { ApprovalRequest, NotifyRequest } = createOpenApiDocument({
    version: TEST_VERSION,
    port: 8787,
    maxTextLength: 3900,
    maxAttachmentBytes: 2048,
  }).components.schemas
  expect(ApprovalRequest.required).toEqual(['text', 'timeoutOption'])
  expect(ApprovalRequest.properties?.allowText).toMatchObject({ type: 'boolean' })
  expect(ApprovalRequest.properties?.options).toMatchObject({
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 64 },
  })
  expect(ApprovalRequest.properties?.options).not.toHaveProperty('minItems')
  expect(ApprovalRequest.properties?.timeout).toMatchObject({ exclusiveMinimum: 0 })
  expect(ApprovalRequest.properties?.project).toMatchObject({ maxLength: 100 })
  expect(NotifyRequest.required).toEqual(['text'])
  expect(Object.keys(NotifyRequest.properties ?? {})).toEqual([
    'text',
    'project',
    'format',
    'attachment',
    'deleteAfter',
  ])
  expect(NotifyRequest.properties?.deleteAfter).toMatchObject({
    type: ['number', 'string'],
    description: expect.stringContaining('ISO 8601'),
  })
})

test('yaml parses back to the document', () => {
  const options = {
    version: TEST_VERSION,
    port: 8787,
    maxTextLength: 3900,
    maxAttachmentBytes: 2048,
  }
  expect(parse(formatOpenApiYaml(options))).toEqual(createOpenApiDocument(options))
})

test('bearer auth is declared and required on the api routes', () => {
  const document = createOpenApiDocument({
    version: TEST_VERSION,
    port: 8787,
    maxTextLength: 3900,
    maxAttachmentBytes: 2048,
  })
  expect(document.components.securitySchemes.bearerAuth).toMatchObject({
    type: 'http',
    scheme: 'bearer',
  })
  expect(document.security).toEqual([{ bearerAuth: [] }])
  expect(document.paths['/openapi.yaml'].get.security).toEqual([])
  const unauthorized = { $ref: '#/components/responses/Unauthorized' }
  expect(document.paths['/request'].post.responses['401']).toEqual(unauthorized)
  expect(document.paths['/notify'].post.responses['401']).toEqual(unauthorized)
  expect(document.paths['/status'].get.responses['401']).toEqual(unauthorized)
})

test('background paths are documented', () => {
  const { paths } = createOpenApiDocument({
    version: TEST_VERSION,
    port: 8787,
    maxTextLength: 3900,
    maxAttachmentBytes: 2048,
  })
  expect(paths['/request/async'].post.responses['202'].headers).toHaveProperty('Location')
  const item = paths['/request/{id}']
  expect(item.get.parameters).toContainEqual(
    expect.objectContaining({ name: 'wait', in: 'query', schema: { type: 'number', minimum: 0 } }),
  )
  expect(item.get.responses).toHaveProperty('404')
  expect(item.delete.responses).toHaveProperty('404')
  expect(item.get).not.toHaveProperty('security')
  expect(item.delete).not.toHaveProperty('security')
  expect(paths['/request/async'].post).not.toHaveProperty('security')
})

const ATTACHMENT_OPTIONS = {
  version: TEST_VERSION,
  port: 8787,
  maxTextLength: 3900,
  maxAttachmentBytes: 2048,
}

test('both bodies reference the Attachment component', () => {
  const { ApprovalRequest, NotifyRequest } =
    createOpenApiDocument(ATTACHMENT_OPTIONS).components.schemas
  for (const body of [ApprovalRequest, NotifyRequest]) {
    expect(body.properties?.attachment).toEqual({ $ref: '#/components/schemas/Attachment' })
  }
})

test('the Attachment component documents name, text and data and the limit', () => {
  const { Attachment } = createOpenApiDocument(ATTACHMENT_OPTIONS).components.schemas
  expect(Attachment).not.toHaveProperty('$schema')
  expect(Attachment.required).toEqual(['name'])
  expect(Attachment.properties?.name).toMatchObject({ maxLength: 255 })
  expect(Attachment.properties).toHaveProperty('text')
  expect(Attachment.properties).toHaveProperty('data')
  expect(Attachment.description).toContain('2048 bytes')
})

test('without attachment support the component says so', () => {
  const { Attachment } = createOpenApiDocument({
    ...ATTACHMENT_OPTIONS,
    maxAttachmentBytes: 0,
  }).components.schemas
  expect(Attachment.description).toContain('not supported')
})

test('request, request/async and notify document a 501', () => {
  const { paths } = createOpenApiDocument(ATTACHMENT_OPTIONS)
  const notSupported = { $ref: '#/components/responses/NotSupported' }
  expect(paths['/request'].post.responses['501']).toEqual(notSupported)
  expect(paths['/request/async'].post.responses['501']).toEqual(notSupported)
  expect(paths['/notify'].post.responses['501']).toEqual(notSupported)
})

test('PayloadTooLarge names the new body limit', () => {
  const { responses } = createOpenApiDocument(ATTACHMENT_OPTIONS).components
  expect(responses.PayloadTooLarge.description).toContain('14680064')
})

test('Status has maxAttachmentBytes', () => {
  const { Status } = createOpenApiDocument(ATTACHMENT_OPTIONS).components.schemas
  expect(JSON.stringify(Status)).toContain('maxAttachmentBytes')
})

test('Status has maxTextLength and maxOptionCount', () => {
  const document = createOpenApiDocument({
    version: TEST_VERSION,
    port: 1,
    maxTextLength: 10,
    maxAttachmentBytes: 0,
  })
  const status = document.components.schemas.Status as {
    readonly oneOf?: readonly { readonly properties?: Record<string, unknown> }[]
    readonly anyOf?: readonly { readonly properties?: Record<string, unknown> }[]
  }
  const branches = status.oneOf ?? status.anyOf ?? []
  expect(branches.length).toBe(2)
  for (const branch of branches) {
    expect(branch.properties).toMatchObject({
      maxTextLength: { type: 'number' },
      maxOptionCount: { type: 'number' },
    })
  }
})

test('maxOptionCount becomes maxItems on request options', () => {
  const withLimit = createOpenApiDocument({
    version: TEST_VERSION,
    port: 1,
    maxTextLength: 1800,
    maxAttachmentBytes: 0,
    maxOptionCount: 25,
  })
  expect(withLimit.components.schemas.ApprovalRequest.properties?.options).toMatchObject({
    maxItems: 25,
  })
  const without = createOpenApiDocument({
    version: TEST_VERSION,
    port: 1,
    maxTextLength: 1800,
    maxAttachmentBytes: 0,
  })
  expect(without.components.schemas.ApprovalRequest.properties?.options).not.toHaveProperty(
    'maxItems',
  )
})

test('/vote is documented with its body and report', () => {
  const document = createOpenApiDocument({
    version: TEST_VERSION,
    port: 8787,
    maxTextLength: 3900,
    maxAttachmentBytes: 0,
  })
  const { VoteRequest, VoteReport, ApprovalRequest } = document.components.schemas
  expect(document.paths['/vote'].post.responses['200']).toMatchObject({
    content: { 'application/json': { schema: { $ref: '#/components/schemas/VoteReport' } } },
  })
  expect(VoteRequest.allOf[0]).toEqual({ $ref: '#/components/schemas/ApprovalRequest' })
  expect(VoteRequest.allOf[1]?.properties).toMatchObject({
    voters: { type: 'array', maxItems: 25 },
    require: { enum: ['all', 'majority'] },
  })
  expect(VoteReport.required).toEqual([
    'answer',
    'timedOut',
    'approved',
    'require',
    'votes',
    'rounds',
  ])
  expect(ApprovalRequest.properties?.retry).toMatchObject({ type: 'integer', maximum: 100 })
})

test('the openapi document lists the admin routes under the adminKey scheme', () => {
  const document = createOpenApiDocument(ATTACHMENT_OPTIONS)
  expect(document.components.securitySchemes.adminKey).toMatchObject({
    type: 'http',
    scheme: 'bearer',
  })
  expect(document.tags).toContainEqual(expect.objectContaining({ name: 'admin' }))
  const routes = [
    ['/admin/bots', 'get'],
    ['/admin/bots', 'post'],
    ['/admin/bots/{id}', 'delete'],
    ['/admin/contacts', 'get'],
    ['/admin/contacts', 'post'],
    ['/admin/contacts/{id}/reset', 'post'],
    ['/admin/contacts/{id}', 'delete'],
    ['/admin/keys', 'get'],
    ['/admin/keys', 'post'],
    ['/admin/keys/{id}', 'patch'],
    ['/admin/keys/{id}', 'delete'],
    ['/admin/log', 'get'],
    ['/admin/admin-key', 'post'],
  ] as const
  const paths: Record<string, Record<string, unknown>> = document.paths
  const adminOperations = Object.entries(paths)
    .filter(([path]) => path.startsWith('/admin/'))
    .flatMap(([path, item]) => Object.keys(item).map((method) => [path, method]))
  expect(adminOperations.toSorted()).toEqual(routes.map((route) => [...route]).toSorted())
  for (const [path, method] of routes) {
    expect(paths[path]?.[method], `${method} ${path}`).toMatchObject({
      tags: ['admin'],
      security: [{ adminKey: [] }],
      responses: { '401': { $ref: '#/components/responses/Unauthorized' } },
    })
  }
  const { AddBotBody, CreateKeyBody, AdminKey, CreatedKey } = document.components.schemas
  expect(AddBotBody.required).toEqual(['provider', 'settings'])
  expect(Object.keys(CreateKeyBody.properties ?? {})).toEqual([
    'bot',
    'contact',
    'sameAsKey',
    'label',
    'externalId',
  ])
  expect(Object.keys(AdminKey.properties ?? {})).not.toContain('hash')
  expect(CreatedKey.required).toEqual(['id', 'key', 'contact'])
  expect(document.paths['/admin/bots'].post.responses).toMatchObject({
    '201': expect.anything(),
    '400': expect.anything(),
    '409': expect.anything(),
  })
})

test('GET /log and the key fields of /status are documented', () => {
  const document = createOpenApiDocument(ATTACHMENT_OPTIONS)
  const log = document.paths['/log'].get
  expect(log.parameters.map((parameter) => parameter.name)).toEqual(['since', 'project', 'limit'])
  expect(log.responses['200']).toMatchObject({
    content: { 'application/json': { schema: { $ref: '#/components/schemas/LogPage' } } },
  })
  expect(log).not.toHaveProperty('security')
  const status = JSON.stringify(document.components.schemas.Status)
  for (const field of ['key', 'contact', 'state', 'error']) {
    expect(status).toContain(`"${field}"`)
  }
  expect(status).toContain('retried with backoff')
})
