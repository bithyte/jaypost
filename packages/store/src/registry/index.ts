export {
  ADMIN_KEY_ENV_VAR,
  ADMIN_KEY_FILE_NAME,
  ADMIN_KEY_PREFIX,
  API_KEY_PREFIX,
  LOCAL_PERSON,
  REGISTRY_VERSION,
} from './constants.ts'
export { generateAdminKey, generateApiKey, hashKey } from './keys.ts'
export {
  addBot,
  applySeed,
  claimCode,
  claimPairing,
  createEmptyRegistry,
  createKey,
  createPairing,
  removeBot,
  removePairing,
  resetPairing,
  revokeKey,
  updateKey,
  updatePairingQuiet,
} from './operations.ts'
export {
  countBotRecords,
  findKeyRoute,
  findPairingOf,
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
  ClaimPairingResult,
  CreateKeyResult,
  CreatePairingResult,
  KeyDetails,
  KeyFilter,
  KeyLookup,
  KeyOnBot,
  KeyPatch,
  KeyRecord,
  KeyTarget,
  ListKeysResult,
  NotFound,
  PairingRecord,
  PendingPairing,
  Registry,
  RemoveResult,
  ResetPairingResult,
  RevokeKeyResult,
  SeedInput,
  SeedLoad,
  SeedRecord,
  SeedResult,
  UpdateKeyResult,
} from './types.ts'
