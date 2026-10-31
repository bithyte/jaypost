export {
  ADMIN_KEY_ENV_VAR,
  ADMIN_KEY_FILE_NAME,
  ADMIN_KEY_PREFIX,
  API_KEY_PREFIX,
  BOT_ID_PREFIX,
  CONTACT_ID_PREFIX,
  KEY_ID_PREFIX,
  LOCAL_PERSON,
  REGISTRY_VERSION,
} from './constants.ts'
export { generateAdminKey, generateApiKey, hashKey } from './keys.ts'
export {
  addBot,
  applySeed,
  claimCode,
  claimContact,
  createEmptyRegistry,
  createKey,
  createContact,
  removeBot,
  removeContact,
  resetContact,
  revokeKey,
  updateKey,
  updateContactQuiet,
} from './operations.ts'
export {
  countBotRecords,
  findKeyRoute,
  findContactOf,
  isPending,
  isSeedLine,
  listKeys,
} from './queries.ts'
export { resolveAdminKeyPath } from './paths.ts'
export { registrySchema } from './schema.ts'
export { loadSeed } from './seed.ts'
export { ensureAdminKey, RegistryStore, resolveAdminKey, writeAdminKeyFile } from './store.ts'
export type {
  AddBotResult,
  BotRecordCounts,
  BotInput,
  BotRecord,
  ClaimCodeResult,
  ClaimContactResult,
  CreateKeyResult,
  CreateContactResult,
  KeyDetails,
  KeyFilter,
  KeyLookup,
  KeyOnBot,
  KeyPatch,
  KeyRecord,
  KeyTarget,
  ListKeysResult,
  NotFound,
  ContactRecord,
  PendingContact,
  Registry,
  RemoveResult,
  ResetContactResult,
  RevokeKeyResult,
  SeedInput,
  SeedLoad,
  SeedRecord,
  SeedResult,
  UpdateKeyResult,
} from './types.ts'
