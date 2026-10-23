// Writes docs/openapi.yaml with the defaults of a fresh install; packages/service/test/server/openapi.test.ts checks it.
import { writeFileSync } from 'node:fs'
import { DEFAULT_PORT } from '@jaypost/store'
import { DEFAULT_PROVIDER, requireProvider, resolveMaxAttachmentBytes } from '@jaypost/core'
import { PROVIDERS } from '@jaypost/providers'
import { formatOpenApiYaml } from '@jaypost/service'

const provider = requireProvider(PROVIDERS, DEFAULT_PROVIDER)
writeFileSync(
  new URL('../../../docs/openapi.yaml', import.meta.url),
  formatOpenApiYaml({
    port: DEFAULT_PORT,
    maxTextLength: provider.maxTextLength,
    maxAttachmentBytes: resolveMaxAttachmentBytes(provider),
    ...(provider.maxOptionCount === undefined ? {} : { maxOptionCount: provider.maxOptionCount }),
  }),
)
