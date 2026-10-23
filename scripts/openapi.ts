// Writes docs/openapi.yaml with the defaults of a fresh install; test/server/openapi.test.ts checks it.
import { writeFileSync } from 'node:fs'
import { DEFAULT_PORT } from '../src/config/index.ts'
import {
  DEFAULT_PROVIDER,
  requireProvider,
  resolveMaxAttachmentBytes,
} from '../src/provider/index.ts'
import { PROVIDERS } from '../src/registry/index.ts'
import { formatOpenApiYaml } from '../src/server/index.ts'

const provider = requireProvider(PROVIDERS, DEFAULT_PROVIDER)
writeFileSync(
  new URL('../docs/openapi.yaml', import.meta.url),
  formatOpenApiYaml({
    port: DEFAULT_PORT,
    maxTextLength: provider.maxTextLength,
    maxAttachmentBytes: resolveMaxAttachmentBytes(provider),
    ...(provider.maxOptionCount === undefined ? {} : { maxOptionCount: provider.maxOptionCount }),
  }),
)
